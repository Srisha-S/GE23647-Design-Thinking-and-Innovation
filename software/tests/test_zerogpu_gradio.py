"""Real local Gradio transport tests, using an injected unit-test predictor.

No model, checkpoint, CUDA allocation or cloud inference is involved. Install
the pinned Gradio/spaces versions in an isolated test environment to run these.
"""
import base64
import importlib.util
import io
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

DEPENDENCIES = importlib.util.find_spec("gradio") is not None and importlib.util.find_spec("spaces") is not None
ROOT = Path(__file__).resolve().parents[1]
if DEPENDENCIES:
    import numpy as np
    from PIL import Image
    from fastapi.testclient import TestClient
    from gradio.routes import App
    from gradio_client import Client
    sys.path.insert(0, str(ROOT / "deploy/huggingface-sam3"))
    try:
        spec = importlib.util.spec_from_file_location("chroma_space_app", ROOT / "deploy/huggingface-sam3/app.py")
        app = importlib.util.module_from_spec(spec)
        with patch.dict("os.environ", {"HF_TOKEN": ""}):
            spec.loader.exec_module(app)
    finally:
        sys.path.pop(0)


@unittest.skipUnless(DEPENDENCIES, "Run in the isolated environment with pinned Gradio/spaces installed.")
class GradioTransportTests(unittest.TestCase):
    def test_named_contract_and_gpu_free_health(self):
        endpoints = app.demo.get_api_info()["named_endpoints"]
        self.assertEqual(set(endpoints), {"/health", "/segment"})
        self.assertEqual(endpoints["/health"]["parameters"], [])
        parameters = endpoints["/segment"]["parameters"]
        self.assertEqual(len(parameters), 1)
        self.assertEqual(parameters[0]["parameter_name"], "request")
        self.assertEqual(parameters[0]["component"], "Json")
        with patch.object(app, "gpu_inference", side_effect=AssertionError("health must not allocate GPU")):
            self.assertFalse(app.health()["ready"])
        dependencies = {item["api_name"]: item for item in app.demo.config["dependencies"]}
        self.assertFalse(dependencies["health"]["queue"])
        self.assertTrue(dependencies["segment"]["queue"])
        self.assertEqual(app.demo._queue.max_size, 16)
        self.assertEqual(app.demo.fns[1].concurrency_limit, 1)

    def test_http_size_and_validation_errors_do_not_echo_photos(self):
        demo = app.build_demo()
        backend = App.create_app(demo, app_kwargs=app.APP_KWARGS)
        with TestClient(backend) as client:
            response = client.post("/gradio_api/call/segment", json={"data": "private-photo"})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("private-photo", response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")
            response = client.post("/gradio_api/call/segment", content="{}", headers={"Content-Length": str(app.MAX_BODY_BYTES + 1), "Content-Type": "application/json"})
            self.assertEqual(response.status_code, 413)
            response = client.post("/gradio_api/call/segment", content=iter([b" " * (app.MAX_BODY_BYTES // 2), b" " * (app.MAX_BODY_BYTES // 2 + 1)]), headers={"Content-Type": "application/json"})
            self.assertEqual(response.status_code, 413)
        demo.close()

    def test_official_client_uses_named_queue_and_json_without_files(self):
        class UnitPredictor:
            def segment(self, image, points, text):
                mask = np.zeros((image.height, image.width), dtype=np.uint8)
                mask[1, 1] = 255
                return mask, 0.9

        service = app.SpaceService(UnitPredictor())

        def health_callback():
            return service.health()

        def segment_callback(request):
            return service.segment(request)

        demo = app.build_demo(health_callback=health_callback, segment_callback=segment_callback)
        with socket.socket() as free_port:
            free_port.bind(("127.0.0.1", 0))
            port = free_port.getsockname()[1]
        _, url, _ = demo.launch(
            server_name="127.0.0.1", server_port=port, prevent_thread_lock=True,
            quiet=True, show_error=False, run_history=False, enable_monitoring=False,
            app_kwargs=app.APP_KWARGS, share=False,
        )
        try:
            client = Client(url, verbose=False)
            self.assertTrue(client.predict(api_name="/health")["ready"])
            stream = io.BytesIO()
            with Image.new("RGB", (4, 3)) as image:
                image.save(stream, format="PNG")
            payload = {
                "image": "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode(),
                "width": 4, "height": 3, "points": [{"x": 1, "y": 1, "label": 1}],
            }
            result = client.predict(request=payload, api_name="/segment")
            self.assertEqual((result["width"], result["height"]), (4, 3))
            self.assertEqual(len(base64.b64decode(result["mask_base64"])), 12)
            self.assertEqual(client.predict(request=payload | {"width": 5}, api_name="/segment")["error"]["code"], "invalid_request")
            self.assertFalse(demo.run_history)
            self.assertFalse(demo.analytics_enabled)
            self.assertFalse(any(block.temp_files for block in demo.blocks.values()))
        finally:
            demo.close()


if __name__ == "__main__":
    unittest.main()
