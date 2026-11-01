"""Gradio-only ZeroGPU runtime for the existing CHROMA SAM 3 contract."""
# Import first: spaces patches CUDA at startup before torch/SAM are imported.
import spaces

import os
os.environ["GRADIO_ANALYTICS_ENABLED"] = "False"
os.environ["GRADIO_RUN_HISTORY"] = "False"

import gradio as gr
from fastapi.exceptions import RequestValidationError
from starlette.middleware import Middleware
from starlette.responses import JSONResponse

from adapter import (
    MAX_BODY_BYTES, SpaceService, failure, initialize_service, run_inference,
)


class BodyLimitsMiddleware:
    """Bound all POST bodies before Gradio parses/queues private image JSON."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def no_cache_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [(b"cache-control", b"no-store")]
            await send(message)

        if scope.get("method") != "POST":
            return await self.app(scope, receive, no_cache_send)
        try:
            headers = dict(scope.get("headers", []))
            length = int(headers.get(b"content-length", b"0"))
            if length < 0:
                raise ValueError
        except ValueError:
            response = JSONResponse(failure("invalid_request", "Invalid request length."), status_code=400)
            return await response(scope, receive, no_cache_send)
        if length > MAX_BODY_BYTES:
            response = JSONResponse(failure("invalid_request", "The request exceeds the 12 MB limit."), status_code=413)
            return await response(scope, receive, no_cache_send)
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                response = JSONResponse(failure("invalid_request", "The request exceeds the 12 MB limit."), status_code=413)
                return await response(scope, receive, no_cache_send)
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()
        return await self.app(scope, bounded_receive, no_cache_send)


async def invalid_api_request(_request, _error):
    # FastAPI/Gradio's default 422 detail can echo arbitrary submitted inputs.
    return JSONResponse(failure("invalid_request", "Invalid API request."), status_code=422)


APP_KWARGS = {
    "middleware": [Middleware(BodyLimitsMiddleware)],
    "exception_handlers": {RequestValidationError: invalid_api_request},
}

# Root initialization uses cached official weights and spaces' CUDA emulation.
# It does not allocate a real GPU. A missing secret leaves health reachable.
service = initialize_service()


@spaces.GPU(duration=60, size="large")
def gpu_inference(image, request):
    return run_inference(service.predictor, image, request)


def health():
    return service.health()


def segment(request):
    # Validation/image decoding take place outside the GPU allocation. Errors
    # are safe JSON envelopes; upstream exceptions never reach public logs.
    return service.segment(request, inference=gpu_inference)


def build_demo(*, health_callback=health, segment_callback=segment):
    with gr.Blocks(title="CHROMA SAM 3", analytics_enabled=False, delete_cache=(300, 300)) as demo:
        gr.Markdown("CHROMA object selection using the official Meta SAM 3 model. Photos are supplied by the CHROMA app over HTTPS.")
        status = gr.JSON(label="Model status")
        gr.Button("Check status").click(
            health_callback, inputs=[], outputs=[status], api_name="health", queue=False,
            preprocess=False, postprocess=False,
        )
        request = gr.JSON(label="request", visible=False)
        result = gr.JSON(label="Selection result", visible=False)
        gr.Button("Segment", visible=False).click(
            segment_callback, inputs=[request], outputs=[result], api_name="segment",
            queue=True, concurrency_limit=1, concurrency_id="sam3-selection",
            # No FileData preprocessing/cache handling of arbitrary JSON.
            preprocess=False, postprocess=False,
        )
    demo.queue(max_size=16, default_concurrency_limit=1)
    return demo


demo = build_demo()

if __name__ == "__main__":
    demo.launch(
        show_error=False, run_history=False, enable_monitoring=False,
        app_kwargs=APP_KWARGS, max_file_size="8mb", share=False,
    )
