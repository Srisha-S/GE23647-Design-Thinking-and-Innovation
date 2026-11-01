"""Protocol/adapter regression tests; no checkpoint or fake live server needed."""
import base64
from contextlib import nullcontext
import io
import json
import math
from types import SimpleNamespace
import unittest

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image

from .app import (
    MAX_BODY_BYTES, NoSurfaceError, Point, Sam3Predictor, SegmentationError,
    Settings, choose_mask, create_app,
)


def request_body(width=4, height=3):
    stream = io.BytesIO()
    with Image.new("RGB", (width, height), (180, 170, 150)) as image:
        image.save(stream, format="PNG")
    return {
        "image": "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii"),
        "width": width, "height": height,
        "points": [{"x": 1, "y": 1, "label": 1}],
    }


class StubPredictor:
    """Injected only into test-created apps; not exposed by the live service."""
    def __init__(self, fail=None, invalid=False):
        self.fail, self.invalid = fail, invalid
        self.calls = []

    def segment(self, image, points, text):
        self.calls.append((image.size, points, text))
        if self.fail:
            raise self.fail
        if self.invalid:
            return np.zeros((1, 1), dtype=np.uint8), 0.4
        mask = np.zeros((image.height, image.width), dtype=np.uint8)
        mask[1, 1:3] = 255
        return mask, 0.9


def client_for(predictor=None):
    return TestClient(create_app(predictor, Settings()), base_url="http://127.0.0.1:8001")


class ServerContractTests(unittest.TestCase):
    def test_health_is_honest_without_model(self):
        with client_for() as client:
            result = client.get("/health")
            self.assertFalse(result.json()["ready"])
            self.assertIn("CHECKPOINT", result.json()["message"])
            self.assertEqual(result.headers["cache-control"], "no-store")
            self.assertEqual(client.post("/segment", json=request_body()).status_code, 503)

    def test_exact_alpha_bytes_and_text(self):
        predictor = StubPredictor()
        body = request_body()
        body["text"] = " curtain "
        with client_for(predictor) as client:
            self.assertTrue(client.get("/health").json()["ready"])
            result = client.post("/segment", json=body)
            self.assertEqual(result.status_code, 200)
            output = result.json()
            self.assertEqual((output["width"], output["height"]), (4, 3))
            self.assertEqual(output["model"], "sam3")
            self.assertEqual(output["score"], 0.9)
            alpha = base64.b64decode(output["mask_base64"], validate=True)
            self.assertEqual(len(alpha), 12)
            self.assertEqual(list(alpha), [0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0])
            self.assertEqual(predictor.calls[0][2], "curtain")
            self.assertEqual(result.headers["cache-control"], "no-store")

    def test_web_and_capacitor_cors(self):
        with client_for(StubPredictor()) as client:
            for origin in ("http://localhost:8000", "http://127.0.0.1:4173", "http://localhost", "https://localhost", "capacitor://localhost"):
                with self.subTest(origin=origin):
                    result = client.options("/segment", headers={
                        "Origin": origin, "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "Content-Type",
                    })
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.headers["access-control-allow-origin"], origin)
                    result = client.post("/segment", json=request_body(), headers={"Origin": origin})
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.headers["access-control-allow-origin"], origin)
            self.assertEqual(client.post("/segment", json=request_body(), headers={"Origin": "https://unrelated.example"}).status_code, 403)
            self.assertEqual(client.get("/health", headers={"Host": "unrelated.example"}).status_code, 400)

    def test_wrong_content_type_and_body_limit(self):
        predictor = StubPredictor()
        with client_for(predictor) as client:
            self.assertEqual(client.post("/segment", content="not JSON").status_code, 415)
            self.assertEqual(client.post("/segment", content="{}", headers={"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)}).status_code, 413)
            self.assertEqual(client.post("/segment", content=(b" " * (MAX_BODY_BYTES + 1)), headers={"Content-Type": "application/json"}).status_code, 413)
            self.assertEqual(client.post("/segment", content=iter([b" " * (MAX_BODY_BYTES // 2), b" " * (MAX_BODY_BYTES // 2 + 1)]), headers={"Content-Type": "application/json"}).status_code, 413)
            self.assertFalse(predictor.calls)

    def test_malformed_requests_do_not_echo_photos(self):
        mutations = [
            {"width": "4"}, {"height": True}, {"width": 2049}, {"image": "private-photo"},
            {"points": []}, {"points": [{"x": 4, "y": 1, "label": 1}]},
            {"points": [{"x": -1, "y": 1, "label": 1}]},
            {"points": [{"x": 1, "y": 1, "label": 0}]},
            {"points": [{"x": "1", "y": 1, "label": 1}]},
            {"points": [{"x": 1, "y": 1, "label": True}]},
            {"points": [{"x": 1, "y": 1, "label": 2}]},
            {"points": [{"x": 1, "y": 1, "label": 1}] * 33},
            {"text": ""}, {"text": "a" * 121}, {"text": "cur\ntain"}, {"unexpected": "private"},
        ]
        predictor = StubPredictor()
        with client_for(predictor) as client:
            for mutation in mutations:
                with self.subTest(mutation=list(mutation)):
                    body = request_body() | mutation
                    result = client.post("/segment", json=body)
                    self.assertEqual(result.status_code, 422)
                    self.assertNotIn(body["image"], result.text)
            for number in (math.nan, math.inf, -math.inf):
                body = request_body()
                body["points"][0]["x"] = number
                result = client.post("/segment", content=json.dumps(body), headers={"Content-Type": "application/json"})
                self.assertEqual(result.status_code, 422)
            self.assertFalse(predictor.calls)

    def test_bad_images_are_rejected_before_prediction(self):
        predictor = StubPredictor()
        with client_for(predictor) as client:
            body = request_body()
            body["width"] = 5
            self.assertEqual(client.post("/segment", json=body).status_code, 422)
            for image in ("https://example.com/photo.png", "data:image/png;base64,@@@@", "data:image/png;base64," + base64.b64encode(b"not an image").decode()):
                self.assertEqual(client.post("/segment", json=request_body() | {"image": image}).status_code, 422)
            self.assertFalse(predictor.calls)

    def test_busy_lock_and_provider_errors(self):
        provider_cases = [(NoSurfaceError("Choose another point."), 422), (SegmentationError("Unexpected mask shape."), 502), (RuntimeError("private data must not escape"), 503)]
        for error, status in provider_cases:
            with self.subTest(status=status):
                with client_for(StubPredictor(error)) as client:
                    result = client.post("/segment", json=request_body())
                    self.assertEqual(result.status_code, status)
                    self.assertNotIn("private data", result.text)
                    self.assertFalse(client.app.state.inference_lock.locked())
        with client_for(StubPredictor(invalid=True)) as client:
            self.assertEqual(client.post("/segment", json=request_body()).status_code, 502)
        with client_for(StubPredictor()) as client:
            lock = client.app.state.inference_lock
            lock.acquire()
            try:
                result = client.post("/segment", json=request_body())
                self.assertEqual(result.status_code, 503)
                self.assertEqual(result.headers["retry-after"], "1")
            finally:
                lock.release()
            self.assertEqual(client.post("/segment", json=request_body()).status_code, 200)


class ModelAdapterTests(unittest.TestCase):
    def test_selects_best_containing_mask_without_unrelated_objects(self):
        masks = np.zeros((3, 3, 4), dtype=bool)
        masks[0, 0, 0] = True
        masks[1, 1, 1:3] = True
        masks[2, 1, 1] = True
        mask, score = choose_mask(masks, [0.99, 0.9, 0.8], (4, 3), [Point(x=1, y=1, label=1)])
        self.assertEqual(score, 0.9)
        self.assertEqual(mask.dtype, np.uint8)
        self.assertEqual(np.count_nonzero(mask), 2)
        self.assertEqual(mask[0, 0], 0)
        mask, score = choose_mask(masks[:, None], [0.99, 0.9, 0.8], (4, 3), [Point(x=1, y=1, label=1), Point(x=2, y=1, label=0)])
        self.assertEqual(score, 0.8)
        self.assertEqual(np.count_nonzero(mask), 1)

    def test_rejects_invalid_empty_nan_and_unmatched_outputs(self):
        point = [Point(x=1, y=1, label=1)]
        invalid = [(np.zeros((0, 3, 4)), []), (np.zeros((1, 3, 4)), [0.9]), (np.zeros((1, 2, 4)), [0.9]), (np.ones((1, 3, 4)), [math.nan]), (np.full((1, 3, 4), math.nan), [0.9])]
        for masks, scores in invalid:
            with self.subTest(shape=masks.shape):
                with self.assertRaises(SegmentationError):
                    choose_mask(masks, scores, (4, 3), point)

    def adapter(self, fail=False):
        adapter = Sam3Predictor.__new__(Sam3Predictor)
        adapter.torch = SimpleNamespace(
            cuda=SimpleNamespace(is_bf16_supported=lambda: True),
            bfloat16="bf16", float16="fp16", inference_mode=nullcontext,
            autocast=lambda *args, **kwargs: nullcontext(),
        )
        state = {"features": "temporary"}
        calls = []
        masks = np.zeros((2, 3, 4), dtype=bool)
        masks[1, 1, 1] = True

        def predict_inst(received_state, **kwargs):
            calls.append((received_state is state, kwargs))
            if fail:
                raise RuntimeError("test inference error")
            return masks, [0.99, 0.9], None

        def set_text_prompt(*, prompt, state):
            calls.append((prompt, state))
            return {"masks": masks[:, None], "scores": [0.99, 0.9]}

        interactive = SimpleNamespace(_features="embedding", _is_image_set=True)
        adapter.model = SimpleNamespace(predict_inst=predict_inst, inst_interactive_predictor=interactive)
        adapter.processor = SimpleNamespace(set_image=lambda image: state, set_text_prompt=set_text_prompt)
        return adapter, state, calls, interactive

    def test_uses_verified_official_point_api_and_releases_embeddings(self):
        adapter, state, calls, interactive = self.adapter()
        with Image.new("RGB", (4, 3)) as image:
            mask, score = adapter.segment(image, [Point(x=1, y=1, label=1)], None)
        self.assertEqual(score, 0.9)
        self.assertEqual(mask[1, 1], 255)
        self.assertTrue(calls[0][0])
        np.testing.assert_array_equal(calls[0][1]["point_coords"], [[1, 1]])
        np.testing.assert_array_equal(calls[0][1]["point_labels"], [1])
        self.assertTrue(calls[0][1]["multimask_output"])
        self.assertFalse(state)
        self.assertIsNone(interactive._features)
        self.assertFalse(interactive._is_image_set)

    def test_uses_text_api_and_releases_embeddings_on_failure(self):
        adapter, state, calls, interactive = self.adapter()
        with Image.new("RGB", (4, 3)) as image:
            adapter.segment(image, [Point(x=1, y=1, label=1)], "curtain")
        self.assertEqual(calls[0][0], "curtain")
        self.assertFalse(state)
        adapter, state, calls, interactive = self.adapter(fail=True)
        with Image.new("RGB", (4, 3)) as image:
            with self.assertRaises(RuntimeError):
                adapter.segment(image, [Point(x=1, y=1, label=1)], None)
        self.assertFalse(state)
        self.assertIsNone(interactive._features)
        self.assertFalse(interactive._is_image_set)


if __name__ == "__main__":
    unittest.main()
