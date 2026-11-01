"""ZeroGPU deployment service; unit injections never configure the live app."""
from __future__ import annotations

from contextlib import contextmanager, redirect_stderr, redirect_stdout
from functools import partial
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import sys
import threading
import warnings

from pydantic import ValidationError

try:
    # The deployment script stages exactly this shared source file in the Space.
    from chroma_sam3_core import (
        MAX_BODY_BYTES, ImageValidationError, NoSurfaceError, Sam3Inference,
        SegmentRequest, SegmentationError, decode_image, encode_mask,
    )
except ModuleNotFoundError as error:
    if error.name != "chroma_sam3_core":
        raise
    # Running tests from the CHROMA repository does not need a staged copy.
    from server.sam3.core import (
        MAX_BODY_BYTES, ImageValidationError, NoSurfaceError, Sam3Inference,
        SegmentRequest, SegmentationError, decode_image, encode_mask,
    )

SAM3_SOURCE_COMMIT = "0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc"
MODEL_REPOSITORY = "facebook/sam3"
MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"
CHECKPOINT_FILENAME = "sam3.pt"
PROVIDER = "huggingface-zerogpu"


def failure(code: str, message: str, retryable: bool = False) -> dict:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


class _DiscardOutput:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


@contextmanager
def private_provider_output():
    """Keep arbitrary upstream diagnostics out of public Space logs.

Inference is serialized. This process-wide suppression also covers Python
warnings and log handlers during model calls, without retaining their content.
Safe status messages are supplied by our code after this context exits.
"""
    previous_level = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        with warnings.catch_warnings(), redirect_stdout(_DiscardOutput()), redirect_stderr(_DiscardOutput()):
            warnings.simplefilter("ignore")
            yield
    finally:
        logging.disable(previous_level)


class ZeroGpuPredictor(Sam3Inference):
    """Initialize the official model under spaces' startup CUDA emulation.

The local adapter deliberately requires a permanently available CUDA device.
ZeroGPU instead provides emulated CUDA at startup, then real CUDA only during
@spaces.GPU. Import spaces before reaching this constructor. Do not move or
reload this model for every request, and never enable torch.compile.
"""
    def __init__(self, checkpoint: str):
        if sys.version_info < (3, 12):
            raise SegmentationError("The Space requires Python 3.12.")
        distribution = importlib.metadata.distribution("sam3")
        source = json.loads(distribution.read_text("direct_url.json") or "{}")
        if (
            source.get("url", "").rstrip("/") != "https://github.com/facebookresearch/sam3.git"
            or source.get("vcs_info", {}).get("commit_id") != SAM3_SOURCE_COMMIT
        ):
            raise SegmentationError("The installed SAM 3 source does not match the official pin.")
        import torch
        from sam3.model_builder import build_sam3_image_model
        from sam3.model.sam3_image_processor import Sam3Processor
        from sam3.sam import transformer as rope_module

        self.torch = torch
        self.model = build_zerogpu_model(build_sam3_image_model, rope_module,
            checkpoint_path=checkpoint, load_from_HF=False,
            enable_inst_interactivity=True, device="cuda", eval_mode=True,
            compile=False,
        )
        self.processor = Sam3Processor(self.model, device="cuda")


def build_zerogpu_model(builder, rope_module, **kwargs):
    """Keep RoPE constants on CPU until SAM's startup layer copies finish.

The pinned SAM builder deep-copies RoPEAttention.freqs_cis (a plain Tensor
attribute) while cloning tracker layers. spaces 0.51.3's CUDA emulation
rejects PyTorch's storage-based deepcopy with a CPU/CUDA mismatch. Compute
only these deterministic constants on CPU during construction, then move
them to emulated CUDA before spaces captures the model. No weights, layer
architecture, inference math or local SAM code are changed.
"""
    original = rope_module.compute_axial_cis

    def cpu_constants(*args, **options):
        return original(*args, **(options | {"device": "cpu"}))

    # Startup is serialized and occurs before Gradio accepts any requests.
    rope_module.compute_axial_cis = cpu_constants
    try:
        model = builder(**kwargs)
    finally:
        rope_module.compute_axial_cis = original
    for module in model.modules():
        if isinstance(module, rope_module.RoPEAttention):
            # The partial captured during construction must also be restored:
            # later shape changes need real CUDA, never the CPU-only wrapper.
            module.compute_cis = partial(original, *module.compute_cis.args,
                                         **module.compute_cis.keywords)
            module.freqs_cis = module.freqs_cis.to(device="cuda")
            if module.use_rope_real:
                module.freqs_cis_real = module.freqs_cis.real
                module.freqs_cis_imag = module.freqs_cis.imag
    return model


def run_inference(predictor, image, request: SegmentRequest) -> dict:
    """Called inside @spaces.GPU; no provider exception escapes with user data."""
    try:
        with private_provider_output():
            mask, score = predictor.segment(image, request.points, request.text)
            return encode_mask(mask, score, request)
    except NoSurfaceError:
        return failure("no_object", "No suitable object was found. Try a clearer point or select manually.")
    except SegmentationError:
        return failure("unavailable", "SAM 3 returned an invalid surface mask. Please retry or select manually.", True)
    except Exception:
        # No str(error), traceback, photo, prompt, mask, checkpoint path or token.
        return failure("unavailable", "Auto Select is temporarily unavailable. Please retry or select manually.", True)


def scheduler_failure(error: Exception) -> dict:
    # spaces 0.51.3 exposes fixed Gradio Error titles. Inspect only the title;
    # never forward its HTML/text which may advise adding tokens or buying GPU.
    title = getattr(error, "title", "")
    if isinstance(title, str) and ("quota" in title.lower() or "credits" in title.lower()):
        return failure("quota", "Auto Select's free GPU quota is unavailable. Select manually or try later.")
    if isinstance(error, TimeoutError) or (isinstance(title, str) and "timeout" in title.lower()):
        return failure("timeout", "Auto Select took too long. Please retry or select manually.", True)
    return failure("unavailable", "Auto Select is temporarily unavailable. Please retry or select manually.", True)


class SpaceService:
    def __init__(self, predictor=None, message: str | None = None, diagnostic: dict | None = None):
        self.predictor = predictor
        self.message = message or ("SAM 3 weights are loaded. GPU allocation occurs during selection." if predictor else "SAM 3 is not ready.")
        self.inference_lock = threading.Lock()
        self.diagnostic = diagnostic

    def health(self) -> dict:
        # Pure status read; it neither downloads a checkpoint nor requests GPU.
        result = {
            "ready": self.predictor is not None,
            "provider": PROVIDER, "model": "sam3", "version": SAM3_SOURCE_COMMIT,
            "message": self.message,
        }
        if self.diagnostic is not None:
            result["diagnostic"] = self.diagnostic
        return result

    def segment(self, payload, inference=None) -> dict:
        image = None
        try:
            if not isinstance(payload, dict):
                return failure("invalid_request", "Use a JSON segmentation request.")
            # An HTTP middleware bounds bytes before parsing. This also protects
            # direct calls and rejects excessive prompts before GPU allocation.
            if len(json.dumps(payload, allow_nan=False, separators=(",", ":")).encode("utf-8")) > MAX_BODY_BYTES:
                return failure("invalid_request", "The request exceeds the 12 MB limit.")
            request = SegmentRequest.model_validate(payload)
            image = decode_image(request)
        except (ValidationError, ImageValidationError, ValueError, TypeError, OverflowError):
            return failure("invalid_request", "Invalid photo, dimensions, points or text. Use a PNG, JPEG or WebP working image up to 2048 pixels.")

        try:
            if self.predictor is None:
                return failure("unavailable", "Auto Select is temporarily unavailable. Please select manually.", True)
            if not self.inference_lock.acquire(blocking=False):
                return failure("unavailable", "A selection is already running. Please wait and retry.", True)
            try:
                if inference is None:
                    # Pure adapter tests inject a predictor into this service.
                    # The live Gradio callback ALWAYS supplies @spaces.GPU.
                    return run_inference(self.predictor, image, request)
                return inference(image, request)
            except Exception as error:
                return scheduler_failure(error)
            finally:
                self.inference_lock.release()
        finally:
            image.close()


def initialize_service(*, token: str | None = None, download=None, predictor_factory=None) -> SpaceService:
    """Server startup only; credentials stay solely in the Space process.

Explicit arguments exist for isolated loader tests, never an environment flag
or public endpoint allowing a fake live predictor.
"""
    token = token if token is not None else os.getenv("HF_TOKEN")
    if not token:
        return SpaceService(message="Model access is not configured. Add the HF_TOKEN Space secret and restart.")
    phase = "checkpoint-download"
    try:
        with private_provider_output():
            if download is None:
                from huggingface_hub import hf_hub_download
                download = hf_hub_download
            checkpoint = download(
                repo_id=MODEL_REPOSITORY, filename=CHECKPOINT_FILENAME,
                revision=MODEL_REVISION, token=token,
            )
            phase = "model-initialization"
            predictor = (predictor_factory or ZeroGpuPredictor)(checkpoint)
        return SpaceService(predictor)
    except Exception as error:
        # Hugging Face and upstream exception strings may contain URLs, paths
        # or credentials. Health/logs never expose them or a traceback.
        # Controlled phase, class and HTTP status aid deployment debugging;
        # never expose exception text, traces, filenames or secret values.
        diagnostic = {"phase": phase, "error_type": type(error).__name__}
        # Public source locations only: no paths, source text, local variables
        # or raw exception messages. Useful for unsupported ZeroGPU operations.
        frames = []
        trace = error.__traceback__
        while trace is not None:
            module = trace.tb_frame.f_globals.get("__name__", "")
            if isinstance(module, str) and module.split(".")[0] in {"adapter", "sam3", "torch", "spaces"}:
                frames.append({"module": module, "function": trace.tb_frame.f_code.co_name, "line": trace.tb_lineno})
            trace = trace.tb_next
        diagnostic["source_frames"] = frames[-6:]
        # Inspect privately to classify known runtime failures; never return text.
        detail = str(error).lower()
        for pattern, code in (("no nvidia driver", "cuda-driver-unavailable"),
                              ("not compiled with cuda", "cuda-build-unavailable"),
                              ("cannot re-initialize cuda", "cuda-fork-initialization"),
                              ("unimplemented", "unsupported-runtime-operation"),
                              ("size mismatch", "checkpoint-shape-mismatch"),
                              ("out of memory", "memory-unavailable"),
                              ("same device", "tensor-device-mismatch")):
            if pattern in detail:
                diagnostic["reason"] = code
                break
        detail = None
        status = getattr(getattr(error, "response", None), "status_code", None)
        if isinstance(status, int):
            diagnostic["http_status"] = status
        if isinstance(error, ModuleNotFoundError) and error.name and all(part.isidentifier() for part in error.name.split(".")):
            diagnostic["missing_module"] = error.name[:120]
        return SpaceService(message="SAM 3 could not initialize. Check the Space secret's official model access and the pinned runtime, then restart.", diagnostic=diagnostic)
    finally:
        token = None
