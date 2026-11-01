"""Shared SAM 3 request validation and inference, independent of HTTP/Gradio.

Runtime initialization remains provider-specific. Neither this module nor its
imports download checkpoints, load a model, or allocate CUDA resources.
"""
from __future__ import annotations

import base64
import binascii
import io
import math
import re
from typing import Literal, Protocol

import numpy as np
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_SIDE = 2048
MAX_PIXELS = 2048 * 2048


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: float = Field(ge=0, allow_inf_nan=False)
    y: float = Field(ge=0, allow_inf_nan=False)
    label: Literal[0, 1]

    @field_validator("label", mode="before")
    @classmethod
    def reject_boolean_label(cls, value):
        if isinstance(value, bool):
            raise ValueError("Point label must be 0 or 1, not a boolean.")
        return value


class SegmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    image: str = Field(min_length=1, max_length=MAX_BODY_BYTES)
    width: int = Field(ge=1, le=MAX_SIDE)
    height: int = Field(ge=1, le=MAX_SIDE)
    points: list[Point] = Field(min_length=1, max_length=32)
    text: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def validate_geometry(self):
        if self.width * self.height > MAX_PIXELS:
            raise ValueError("Image has too many pixels.")
        if not any(point.label == 1 for point in self.points):
            raise ValueError("At least one positive point is required.")
        if any(point.x >= self.width or point.y >= self.height for point in self.points):
            raise ValueError("Point coordinates must be inside the image.")
        if self.text is not None:
            self.text = self.text.strip()
            if not self.text or any(ord(character) < 32 for character in self.text):
                raise ValueError("Text must be a short, nonempty surface description.")
        return self


class ImageValidationError(Exception):
    """Trusted input diagnostic without private image/prompt data."""
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class SegmentationError(Exception):
    """Safe, actionable errors that do not include submitted image data."""


class NoSurfaceError(SegmentationError):
    pass


class Predictor(Protocol):
    def segment(self, image: Image.Image, points: list[Point], text: str | None) -> tuple[np.ndarray, float]: ...


def decode_image(request: SegmentRequest) -> Image.Image:
    """Validate actual decoded geometry before allocating the RGB image."""
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", request.image)
    if not match:
        raise ImageValidationError(422, "Image must be a PNG, JPEG or WebP base64 data URL.")
    encoded = match.group(2)
    if len(encoded) > math.ceil(MAX_IMAGE_BYTES / 3) * 4:
        raise ImageValidationError(413, "Encoded image exceeds the 8 MB limit.")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ImageValidationError(422, "Image contains invalid base64.") from None
    if len(payload) > MAX_IMAGE_BYTES:
        raise ImageValidationError(413, "Image exceeds the 8 MB limit.")
    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ImageValidationError(422, "Unsupported image format.")
            if getattr(image, "n_frames", 1) != 1:
                raise ImageValidationError(422, "Use a single still image.")
            if image.size != (request.width, request.height):
                raise ImageValidationError(422, "Image dimensions do not match the request.")
            # The client has already oriented/resized its working canvas. Rotating
            # or resizing again would change the point/mask coordinate system.
            image.load()
            return image.convert("RGB")
    except ImageValidationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ImageValidationError(422, "Image could not be decoded safely.") from None


def choose_mask(masks, scores, size: tuple[int, int], points: list[Point]) -> tuple[np.ndarray, float]:
    """Return one actual model mask containing the requested surface points."""
    if hasattr(masks, "detach"):
        masks = masks.detach().cpu().numpy()
    if hasattr(scores, "detach"):
        scores = scores.detach().float().cpu().numpy()
    masks = np.asarray(masks)
    scores = np.asarray(scores, dtype=np.float64).reshape(-1)
    if masks.ndim == 4 and masks.shape[1] == 1:
        masks = masks[:, 0]
    if masks.ndim == 2:
        masks = masks[None]
    width, height = size
    if masks.ndim != 3 or masks.shape[1:] != (height, width) or len(masks) != len(scores):
        raise SegmentationError("SAM 3 returned an unexpected mask shape. Check the installed model version.")
    if len(masks) == 0:
        raise NoSurfaceError("SAM 3 did not find this surface. Try another point or remove the text description.")
    if not np.isfinite(masks).all() or not np.isfinite(scores).all():
        raise SegmentationError("SAM 3 returned invalid mask values.")
    binary = masks > 0.5
    candidates = [
        index for index, mask in enumerate(binary)
        if mask.any() and all(bool(mask[int(point.y), int(point.x)]) == bool(point.label) for point in points)
    ]
    if not candidates:
        raise NoSurfaceError("No SAM 3 mask matches the selected points. Try a clearer point on the surface.")
    index = max(candidates, key=lambda candidate: scores[candidate])
    return np.ascontiguousarray(binary[index], dtype=np.uint8) * 255, float(np.clip(scores[index], 0, 1))


def encode_mask(mask, score: float, request: SegmentRequest) -> dict:
    """Encode a strict binary mask using CHROMA's existing raw-alpha contract."""
    mask = np.asarray(mask)
    if (
        mask.shape != (request.height, request.width)
        or mask.dtype != np.uint8
        or not mask.any()
        or not np.all((mask == 0) | (mask == 255))
        or not math.isfinite(score)
    ):
        raise SegmentationError("SAM 3 returned an invalid surface mask.")
    if any(bool(mask[int(point.y), int(point.x)]) != bool(point.label) for point in request.points):
        raise NoSurfaceError("No SAM 3 mask matches the selected points.")
    payload = np.ascontiguousarray(mask).tobytes()
    if len(payload) != request.width * request.height:
        raise SegmentationError("SAM 3 returned an invalid surface mask.")
    return {
        "width": request.width, "height": request.height,
        "model": "sam3", "score": float(np.clip(score, 0, 1)),
        "mask_base64": base64.b64encode(payload).decode("ascii"),
    }


class Sam3Inference:
    """Official image/point inference shared by local CUDA and ZeroGPU adapters.

Providers initialize ``torch``, ``model`` and ``processor`` once; only this
method performs inference. No fallback model or injected live mode exists.
"""
    def segment(self, image: Image.Image, points: list[Point], text: str | None) -> tuple[np.ndarray, float]:
        state = None
        torch = self.torch
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        try:
            with torch.inference_mode(), torch.autocast("cuda", dtype=dtype):
                state = self.processor.set_image(image)
                if text:
                    output = self.processor.set_text_prompt(prompt=text, state=state)
                    masks, scores = output["masks"], output["scores"]
                else:
                    masks, scores, _ = self.model.predict_inst(
                        state,
                        point_coords=np.asarray([[p.x, p.y] for p in points], dtype=np.float32),
                        point_labels=np.asarray([p.label for p in points], dtype=np.int32),
                        multimask_output=True,
                    )
                return choose_mask(masks, scores, image.size, points)
        finally:
            interactive = getattr(self.model, "inst_interactive_predictor", None)
            if interactive is not None:
                interactive._features = None
                interactive._is_image_set = False
            if state is not None:
                state.clear()
