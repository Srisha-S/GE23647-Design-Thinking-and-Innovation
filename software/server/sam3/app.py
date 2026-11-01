"""Run from the project root: python -m uvicorn server.sam3.app:app --port 8001.

Only Meta's actual SAM 3 model is used in production. No model checkpoint is
downloaded automatically, and photographs/embeddings are not stored on disk.
"""
from __future__ import annotations

import base64
from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
import math
import os
from pathlib import Path
import re
import sys
import threading

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import numpy as np
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .core import (
    MAX_BODY_BYTES, MAX_IMAGE_BYTES, MAX_SIDE, MAX_PIXELS,
    ImageValidationError, NoSurfaceError, Point, Predictor, Sam3Inference,
    SegmentRequest, SegmentationError, choose_mask, decode_image as _decode_image,
)

LOGGER = logging.getLogger("chroma.sam3")
DEFAULT_ORIGINS = (
    "http://localhost:8000", "http://127.0.0.1:8000",
    "http://localhost:4173", "http://127.0.0.1:4173",
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost", "https://localhost", "capacitor://localhost",
)


def decode_image(request: SegmentRequest):
    """Keep the local HTTP diagnostics while sharing exact image validation."""
    try:
        return _decode_image(request)
    except ImageValidationError as error:
        raise HTTPException(error.status_code, str(error)) from None


class Sam3Predictor(Sam3Inference):
    """Adapter for the official SAM 3 image and interactive instance APIs."""

    def __init__(self, checkpoint: str):
        if sys.version_info < (3, 12):
            raise SegmentationError("SAM 3 needs Python 3.12 or newer. Use the dedicated environment in server/sam3/README.md.")
        checkpoint_path = Path(checkpoint).expanduser().resolve()
        if not checkpoint_path.is_file():
            raise SegmentationError("CHROMA_SAM3_CHECKPOINT must point to the downloaded official sam3.pt file.")
        try:
            import torch
            from sam3.model_builder import build_sam3_image_model
            from sam3.model.sam3_image_processor import Sam3Processor
        except ImportError:
            raise SegmentationError("Install CUDA PyTorch and Meta SAM 3 in the dedicated environment; see server/sam3/README.md.") from None
        version = re.match(r"^(\d+)\.(\d+)", torch.__version__)
        if not version or tuple(map(int, version.groups())) < (2, 7):
            raise SegmentationError("SAM 3 requires PyTorch 2.7 or newer.")
        cuda_version = re.match(r"^(\d+)\.(\d+)", torch.version.cuda or "")
        if not torch.cuda.is_available() or not cuda_version or tuple(map(int, cuda_version.groups())) < (12, 6):
            raise SegmentationError("A CUDA-enabled PyTorch build with CUDA 12.6 or newer and an available NVIDIA GPU is required.")
        self.torch = torch
        # Explicit checkpoint + load_from_HF=False prevents any implicit download.
        # Interactivity is disabled by default upstream; enable it for tap input.
        self.model = build_sam3_image_model(
            checkpoint_path=str(checkpoint_path), load_from_HF=False,
            enable_inst_interactivity=True, device="cuda", eval_mode=True,
        )
        self.processor = Sam3Processor(self.model, device="cuda")


@dataclass
class Settings:
    origins: tuple[str, ...] = DEFAULT_ORIGINS
    hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]")
    checkpoint: str = ""

    @classmethod
    def from_environment(cls):
        origins = tuple(x.strip() for x in os.getenv("CHROMA_SAM3_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",") if x.strip())
        hosts = tuple(x.strip() for x in os.getenv("CHROMA_SAM3_HOSTS", "localhost,127.0.0.1,[::1]").split(",") if x.strip())
        if "*" in origins or "*" in hosts:
            raise ValueError("Configure specific CHROMA origins and hosts; wildcard access is not supported.")
        return cls(origins, hosts, os.getenv("CHROMA_SAM3_CHECKPOINT", ""))


class RequestLimitsMiddleware:
    """Bound bodies, reject unrelated browser origins and disable response cache."""

    def __init__(self, app, origins: tuple[str, ...]):
        self.app = app
        self.origins = origins

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        origin = headers.get(b"origin", b"").decode("latin1")
        if origin and origin not in self.origins:
            return await JSONResponse({"detail": "Origin is not allowed."}, status_code=403)(scope, receive, send)

        async def no_cache_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [(b"cache-control", b"no-store")]
            await send(message)

        if scope.get("path") == "/segment" and scope.get("method") == "POST":
            content_type = headers.get(b"content-type", b"").split(b";")[0].strip().lower()
            if content_type != b"application/json":
                return await JSONResponse({"detail": "Use application/json."}, status_code=415)(scope, receive, no_cache_send)
            try:
                length = int(headers.get(b"content-length", b"0"))
                if length < 0:
                    raise ValueError
            except ValueError:
                return await JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)(scope, receive, no_cache_send)
            if length > MAX_BODY_BYTES:
                return await JSONResponse({"detail": "Request exceeds the 12 MB limit."}, status_code=413)(scope, receive, no_cache_send)
            chunks, total = [], 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                total += len(chunk)
                if total > MAX_BODY_BYTES:
                    return await JSONResponse({"detail": "Request exceeds the 12 MB limit."}, status_code=413)(scope, receive, no_cache_send)
                chunks.append(chunk)
                if not message.get("more_body", False):
                    break
            body = b"".join(chunks)
            delivered = False

            async def limited_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            return await self.app(scope, limited_receive, no_cache_send)
        return await self.app(scope, receive, no_cache_send)


def create_app(predictor: Predictor | None = None, settings: Settings | None = None) -> FastAPI:
    """Predictor injection is for isolated tests, never a fake production mode."""
    settings = settings or Settings.from_environment()
    model_state = {"predictor": predictor, "message": "SAM 3 is ready." if predictor else "SAM 3 is not configured."}
    inference_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(_app):
        if model_state["predictor"] is None:
            if not settings.checkpoint:
                model_state["message"] = "Set CHROMA_SAM3_CHECKPOINT to an approved official sam3.pt checkpoint and restart. See server/sam3/README.md."
            else:
                try:
                    model_state["predictor"] = await run_in_threadpool(Sam3Predictor, settings.checkpoint)
                    model_state["message"] = "SAM 3 is ready."
                except SegmentationError as error:
                    model_state["message"] = str(error)
                    LOGGER.warning("SAM 3 unavailable: %s", error)
                except Exception:
                    model_state["message"] = "SAM 3 could not load. Check the server log, checkpoint, dependencies and GPU memory."
                    LOGGER.exception("SAM 3 model initialization failed")
        yield
        model_state["predictor"] = None

    app = FastAPI(title="CHROMA SAM 3", version="1", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(RequestLimitsMiddleware, origins=settings.origins)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.origins), allow_methods=["GET", "POST"], allow_headers=["Content-Type"], allow_credentials=False)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.hosts))
    app.state.model_state = model_state
    app.state.inference_lock = inference_lock

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, error):
        # Default validation bodies can echo the entire image. Keep only locations
        # and generic messages; never copy image/text inputs into logs or replies.
        errors = [{"field": ".".join(map(str, item["loc"])), "message": item["msg"]} for item in error.errors()]
        return JSONResponse({"detail": "Invalid segmentation request.", "errors": errors}, status_code=422)

    @app.get("/health")
    def health():
        return {"ready": model_state["predictor"] is not None, "model": "sam3", "message": model_state["message"]}

    @app.post("/segment")
    def segment(request: SegmentRequest):
        image = decode_image(request)
        try:
            current = model_state["predictor"]
            if current is None:
                raise HTTPException(503, model_state["message"])
            if not inference_lock.acquire(blocking=False):
                raise HTTPException(503, "SAM 3 is busy. Wait for the current selection to finish.", headers={"Retry-After": "1"})
            try:
                mask, score = current.segment(image, request.points, request.text)
                # Validate adapter output as strictly as client inputs. A wrong
                # shape cannot recolour an unrelated part of the photograph.
                mask = np.asarray(mask)
                if mask.shape != (request.height, request.width) or mask.dtype != np.uint8 or not mask.any() or not math.isfinite(score):
                    raise SegmentationError("SAM 3 returned an invalid surface mask.")
                return {
                    "width": request.width, "height": request.height,
                    "model": "sam3", "score": float(np.clip(score, 0, 1)),
                    "mask_base64": base64.b64encode(np.ascontiguousarray(mask).tobytes()).decode("ascii"),
                }
            except NoSurfaceError as error:
                raise HTTPException(422, str(error)) from None
            except SegmentationError as error:
                raise HTTPException(502, str(error)) from None
            except Exception as error:
                # Exception strings from a provider may contain arbitrary data;
                # print only the exception class, never submitted photo/prompt.
                LOGGER.error("SAM 3 inference failed (%s)", type(error).__name__)
                raise HTTPException(503, "SAM 3 inference failed. Check GPU memory and the server environment, then retry.") from None
            finally:
                inference_lock.release()
        finally:
            image.close()

    return app


app = create_app()
