"""Cloud protocol/loader tests with injected predictors, never real inference.

Run from the root: python -m unittest discover -s tests -p test_zerogpu_adapter.py -v
"""
import base64
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
from functools import partial
import json
import logging
import math
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("chroma_zerogpu_adapter", ROOT / "deploy/huggingface-sam3/adapter.py")
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


def request_body(width=4, height=3, format="PNG", exif=None):
    stream = io.BytesIO()
    with Image.new("RGB", (width, height), (180, 170, 150)) as image:
        options = {"exif": exif} if exif else {}
        image.save(stream, format=format, **options)
    mime = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}.get(format, "png")
    return {
        "image": "data:image/" + mime + ";base64," + base64.b64encode(stream.getvalue()).decode("ascii"),
        "width": width, "height": height,
        "points": [{"x": 1, "y": 1, "label": 1}],
    }


class TestPredictor:
    def __init__(self, output=None, error=None):
        self.output = output
        self.error = error
        self.calls = []

    def segment(self, image, points, text):
        self.calls.append((image, image.size, points, text))
        if self.error:
            print("private-photo must not be logged")
            logging.warning("private-photo must not be logged")
            raise self.error
        if self.output is not None:
            return self.output
        mask = np.zeros((image.height, image.width), dtype=np.uint8)
        mask[1, 1:3] = 255
        return mask, 0.9


class CloudContractTests(unittest.TestCase):
    def test_health_never_invokes_model_or_gpu(self):
        unavailable = adapter.SpaceService()
        self.assertFalse(unavailable.health()["ready"])
        predictor = TestPredictor()
        service = adapter.SpaceService(predictor)
        result = service.health()
        self.assertTrue(result["ready"])
        self.assertEqual(result["provider"], "huggingface-zerogpu")
        self.assertEqual(result["model"], "sam3")
        self.assertEqual(result["version"], adapter.SAM3_SOURCE_COMMIT)
        self.assertFalse(predictor.calls)

    def test_real_contract_alpha_and_optional_text(self):
        predictor = TestPredictor()
        service = adapter.SpaceService(predictor)
        output = service.segment(request_body() | {"text": " curtain "})
        self.assertEqual((output["width"], output["height"]), (4, 3))
        self.assertEqual(output["model"], "sam3")
        self.assertEqual(output["score"], 0.9)
        alpha = base64.b64decode(output["mask_base64"], validate=True)
        self.assertEqual(len(alpha), 12)
        self.assertEqual(list(alpha), [0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0])
        self.assertEqual(predictor.calls[0][3], "curtain")
        with self.assertRaises(ValueError):
            predictor.calls[0][0].getpixel((0, 0))  # request image is closed

    def test_positive_and_negative_points_and_all_supported_formats(self):
        for format in ("PNG", "JPEG", "WEBP"):
            with self.subTest(format=format):
                body = request_body(format=format)
                body["points"].append({"x": 0, "y": 0, "label": 0})
                predictor = TestPredictor()
                output = adapter.SpaceService(predictor).segment(body)
                self.assertNotIn("error", output)
                self.assertEqual([point.label for point in predictor.calls[0][2]], [1, 0])

    def test_rejects_invalid_requests_before_allocating_gpu(self):
        predictor = TestPredictor()
        service = adapter.SpaceService(predictor)
        gpu = Mock(side_effect=AssertionError("GPU must not be requested"))
        mutations = [
            {"width": "4"}, {"width": True}, {"height": 0}, {"height": 2049},
            {"points": []}, {"points": [{"x": 1, "y": 1, "label": 0}]},
            {"points": [{"x": 4, "y": 1, "label": 1}]},
            {"points": [{"x": -1, "y": 1, "label": 1}]},
            {"points": [{"x": 1, "y": 1, "label": True}]},
            {"points": [{"x": "1", "y": 1, "label": 1}]},
            {"points": [{"x": 1, "y": 1, "label": 2}]},
            {"points": [{"x": 1, "y": 1, "label": 1}] * 33},
            {"points": [{"x": math.nan, "y": 1, "label": 1}]},
            {"points": [{"x": math.inf, "y": 1, "label": 1}]},
            {"text": ""}, {"text": "a" * 121}, {"text": "cur\ntain"},
            {"unexpected": "private-photo"},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation.keys()):
                body = request_body() | mutation
                output = service.segment(body, inference=gpu)
                self.assertEqual(output["error"]["code"], "invalid_request")
                self.assertNotIn(body["image"], json.dumps(output))
        for payload in ([], None, "private-photo"):
            self.assertEqual(service.segment(payload, inference=gpu)["error"]["code"], "invalid_request")
        gpu.assert_not_called()
        self.assertFalse(predictor.calls)

    def test_malformed_oversized_and_mismatched_images(self):
        service = adapter.SpaceService(TestPredictor())
        gpu = Mock()
        bad_images = [
            "private-photo", "data:image/png;base64,@@@", "https://example.com/photo.png",
            "data:image/png;base64," + base64.b64encode(b"not-an-image").decode(),
            "data:image/png;base64," + ("A" * (math.ceil(8 * 1024 * 1024 / 3) * 4 + 4)),
        ]
        for image in bad_images:
            self.assertEqual(service.segment(request_body() | {"image": image}, inference=gpu)["error"]["code"], "invalid_request")
        self.assertEqual(service.segment(request_body() | {"width": 5}, inference=gpu)["error"]["code"], "invalid_request")
        oversized_actual = request_body(2049, 3) | {"width": 2048}
        self.assertEqual(service.segment(oversized_actual, inference=gpu)["error"]["code"], "invalid_request")
        # True image format is checked independently of its claimed data URL.
        gif = request_body(format="GIF")
        self.assertEqual(service.segment(gif, inference=gpu)["error"]["code"], "invalid_request")
        gpu.assert_not_called()

    def test_exif_does_not_rotate_a_working_canvas_twice(self):
        exif = Image.Exif()
        exif[274] = 6
        body = request_body(format="JPEG", exif=exif)
        predictor = TestPredictor()
        result = adapter.SpaceService(predictor).segment(body)
        self.assertNotIn("error", result)
        self.assertEqual(predictor.calls[0][1], (4, 3))
        mismatch = body | {"width": 3, "height": 4}
        self.assertEqual(adapter.SpaceService(TestPredictor()).segment(mismatch)["error"]["code"], "invalid_request")

    def test_invalid_masks_and_scores_cannot_escape(self):
        cases = [
            (np.ones((2, 4), dtype=np.uint8) * 255, 0.9),
            (np.ones((3, 4), dtype=np.float32), 0.9),
            (np.zeros((3, 4), dtype=np.uint8), 0.9),
            (np.ones((3, 4), dtype=np.uint8), 0.9),
            (np.ones((3, 4), dtype=np.uint8) * 255, math.nan),
            (np.ones((3, 4), dtype=np.uint8) * 255, math.inf),
        ]
        for output in cases:
            with self.subTest(shape=output[0].shape, score=output[1]):
                result = adapter.SpaceService(TestPredictor(output=output)).segment(request_body())
                self.assertEqual(result["error"]["code"], "unavailable")
                self.assertNotIn("mask_base64", result)
        empty_tap = np.zeros((3, 4), dtype=np.uint8)
        empty_tap[0, 0] = 255
        result = adapter.SpaceService(TestPredictor(output=(empty_tap, 0.9))).segment(request_body())
        self.assertEqual(result["error"]["code"], "no_object")

    def test_no_object_and_provider_failure_preserve_privacy_and_cleanup(self):
        for error, code in [
            (adapter.NoSurfaceError("private-photo"), "no_object"),
            (adapter.SegmentationError("private-photo"), "unavailable"),
            (RuntimeError("private-photo secret-placeholder"), "unavailable"),
        ]:
            predictor = TestPredictor(error=error)
            service = adapter.SpaceService(predictor)
            log = io.StringIO()
            with redirect_stdout(log), redirect_stderr(log):
                output = service.segment(request_body())
            self.assertEqual(output["error"]["code"], code)
            self.assertNotIn("private-photo", json.dumps(output) + log.getvalue())
            self.assertNotIn("secret-placeholder", json.dumps(output) + log.getvalue())
            self.assertFalse(service.inference_lock.locked())
            with self.assertRaises(ValueError):
                predictor.calls[-1][0].getpixel((0, 0))

    def test_scheduler_timeout_quota_and_unavailable_are_safe(self):
        service = adapter.SpaceService(TestPredictor())
        quota = RuntimeError("secret-placeholder")
        quota.title = "ZeroGPU quota exceeded"
        queue_timeout = RuntimeError("private-photo")
        queue_timeout.title = "ZeroGPU queue timeout"
        for error, code in [(quota, "quota"), (queue_timeout, "timeout"), (TimeoutError("private-photo"), "timeout"), (RuntimeError("private-photo"), "unavailable")]:
            output = service.segment(request_body(), inference=Mock(side_effect=error))
            self.assertEqual(output["error"]["code"], code)
            self.assertNotIn("private-photo", json.dumps(output))
            self.assertFalse(service.inference_lock.locked())

    def test_unavailable_and_busy_never_start_another_job(self):
        gpu = Mock()
        self.assertEqual(adapter.SpaceService().segment(request_body(), inference=gpu)["error"]["code"], "unavailable")
        service = adapter.SpaceService(TestPredictor())
        service.inference_lock.acquire()
        try:
            self.assertEqual(service.segment(request_body(), inference=gpu)["error"]["code"], "unavailable")
        finally:
            service.inference_lock.release()
        gpu.assert_not_called()


class CloudInitializationTests(unittest.TestCase):
    def test_missing_secret_never_downloads_or_loads(self):
        download, factory = Mock(), Mock()
        with patch.dict("os.environ", {"HF_TOKEN": ""}):
            service = adapter.initialize_service(download=download, predictor_factory=factory)
        self.assertFalse(service.health()["ready"])
        download.assert_not_called()
        factory.assert_not_called()

    def test_cached_official_download_uses_only_server_secret(self):
        download = Mock(return_value="/private-cache/sam3.pt")
        predictor = TestPredictor()
        factory = Mock(return_value=predictor)
        service = adapter.initialize_service(token="secret-placeholder", download=download, predictor_factory=factory)
        download.assert_called_once_with(
            repo_id="facebook/sam3", filename="sam3.pt",
            revision=adapter.MODEL_REVISION, token="secret-placeholder",
        )
        factory.assert_called_once_with("/private-cache/sam3.pt")
        self.assertTrue(service.health()["ready"])
        self.assertNotIn("secret-placeholder", json.dumps(service.health()))
        self.assertNotIn("private-cache", json.dumps(service.health()))

    def test_loader_exception_output_paths_and_secret_are_redacted(self):
        def failed_download(**kwargs):
            print("secret-placeholder /private-cache/sam3.pt")
            logging.error("secret-placeholder /private-cache/sam3.pt")
            raise RuntimeError("secret-placeholder /private-cache/sam3.pt")
        log = io.StringIO()
        with redirect_stdout(log), redirect_stderr(log):
            service = adapter.initialize_service(token="secret-placeholder", download=failed_download)
        self.assertFalse(service.health()["ready"])
        self.assertNotIn("secret-placeholder", json.dumps(service.health()) + log.getvalue())
        self.assertNotIn("private-cache", json.dumps(service.health()) + log.getvalue())

    def test_deployment_initialization_keeps_official_pin_and_compile_off(self):
        builder, processor = Mock(return_value=SimpleNamespace(modules=lambda: [])), Mock(return_value=object())
        fake_builder = ModuleType("sam3.model_builder")
        fake_builder.build_sam3_image_model = builder
        fake_processor = ModuleType("sam3.model.sam3_image_processor")
        fake_processor.Sam3Processor = processor
        fake_rope = ModuleType("sam3.sam.transformer")
        fake_rope.compute_axial_cis = Mock()
        fake_rope.RoPEAttention = type("RoPEAttention", (), {})
        fake_sam = ModuleType("sam3.sam")
        fake_sam.transformer = fake_rope
        source = {"url": "https://github.com/facebookresearch/sam3.git", "vcs_info": {"commit_id": adapter.SAM3_SOURCE_COMMIT}}
        distribution = SimpleNamespace(read_text=lambda _: json.dumps(source))
        # There is no real model/torch/GPU in this constructor test.
        with patch.object(adapter.sys, "version_info", (3, 12, 12)), patch.object(adapter.importlib.metadata, "distribution", return_value=distribution), patch.dict(sys.modules, {
            "torch": ModuleType("torch"), "sam3.model_builder": fake_builder,
            "sam3.model.sam3_image_processor": fake_processor,
            "sam3.sam": fake_sam, "sam3.sam.transformer": fake_rope,
        }):
            predictor = adapter.ZeroGpuPredictor("/private-cache/sam3.pt")
        builder.assert_called_once_with(checkpoint_path="/private-cache/sam3.pt", load_from_HF=False, enable_inst_interactivity=True, device="cuda", eval_mode=True, compile=False)
        processor.assert_called_once_with(predictor.model, device="cuda")
        source["vcs_info"]["commit_id"] = "unofficial"
        with patch.object(adapter.sys, "version_info", (3, 12, 12)), patch.object(adapter.importlib.metadata, "distribution", return_value=distribution):
            with self.assertRaises(adapter.SegmentationError):
                adapter.ZeroGpuPredictor("/private-cache/sam3.pt")

    def test_rope_copy_workaround_restores_runtime_device_and_constants(self):
        original = Mock(return_value="constant")
        rope = SimpleNamespace(compute_axial_cis=original, RoPEAttention=type("RoPEAttention", (), {}))
        attention = rope.RoPEAttention()
        tensor = Mock()
        moved = SimpleNamespace(real="real", imag="imag")
        tensor.to.return_value = moved
        attention.freqs_cis = tensor
        attention.use_rope_real = True

        def builder(**kwargs):
            attention.compute_cis = partial(rope.compute_axial_cis, dim=64, theta=10000)
            self.assertEqual(attention.compute_cis(end_x=72, end_y=72, device="cuda"), "constant")
            original.assert_called_once_with(dim=64, theta=10000, end_x=72, end_y=72, device="cpu")
            return SimpleNamespace(modules=lambda: [attention])

        adapter.build_zerogpu_model(builder, rope, device="cuda")
        self.assertIs(rope.compute_axial_cis, original)
        self.assertIs(attention.compute_cis.func, original)
        self.assertIs(attention.freqs_cis, moved)
        self.assertEqual(attention.freqs_cis_real, "real")
        self.assertEqual(attention.freqs_cis_imag, "imag")
        tensor.to.assert_called_once_with(device="cuda")
        attention.compute_cis(end_x=36, end_y=36, device="cuda")
        self.assertEqual(original.call_args.kwargs["device"], "cuda")

    def test_rope_workaround_restores_upstream_factory_after_startup_failure(self):
        original = Mock()
        rope = SimpleNamespace(compute_axial_cis=original)
        with self.assertRaises(RuntimeError):
            adapter.build_zerogpu_model(Mock(side_effect=RuntimeError("startup")), rope)
        self.assertIs(rope.compute_axial_cis, original)


if __name__ == "__main__":
    unittest.main()
