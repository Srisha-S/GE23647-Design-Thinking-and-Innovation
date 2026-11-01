"""Deployment manifest and account safeguards with temporary files and a fake Hub API.

No Hugging Face account, HTTP request, hardware change or secret is used.
"""
from __future__ import annotations

from contextlib import ExitStack, redirect_stdout
from enum import Enum
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("chroma_deployment_under_test", ROOT / "scripts" / "deploy_sam3_space.py")
assert SPEC is not None and SPEC.loader is not None
deployment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deployment)
ALLOWED = {"app.py", "adapter.py", "space_adapter.py", "service.py", "requirements.txt", "packages.txt", "README.md", ".gitignore", "chroma_sam3_core.py"}
SYNTHETIC_SECRET = "hf_" + "syntheticCredentialFixture1234567890"


class NotFound(Exception):
    pass


class FakeHardware(str, Enum):
    ZERO_A10G = "zero-a10g"


class FakeApi:
    def __init__(self, hardware="zero-a10g", requested="zero-a10g", private=False, sdk="gradio", missing=False, secret=True):
        self.hardware, self.requested, self.private, self.sdk = hardware, requested, private, sdk
        self.missing, self.secret = missing, secret
        self.calls = []
        self.uploads = []

    def space_info(self, repo):
        self.calls.append(("space_info", repo))
        if self.missing:
            self.missing = False
            raise NotFound("Space does not exist")
        return SimpleNamespace(sdk=self.sdk, private=self.private)

    def create_repo(self, **kwargs):
        self.calls.append(("create_repo", kwargs))

    def get_space_runtime(self, repo):
        self.calls.append(("get_space_runtime", repo))
        return SimpleNamespace(hardware=self.hardware, requested_hardware=self.requested)

    def upload_folder(self, **kwargs):
        folder = Path(kwargs["folder_path"])
        files = {path.name: path.read_bytes() for path in folder.iterdir()}
        self.uploads.append(files)
        self.calls.append(("upload_folder", kwargs))
        return SimpleNamespace(oid="synthetic-commit-id")

    def list_repo_files(self, repo, **kwargs):
        self.calls.append(("list_repo_files", repo))
        return [".gitattributes", *self.uploads[-1]]

    def get_space_secrets(self, repo):
        self.calls.append(("get_space_secrets", repo))
        # Metadata is deliberately sensitive-looking to prove it is not printed.
        return {"HF_TOKEN": SimpleNamespace(description=SYNTHETIC_SECRET)} if self.secret else {}


class DeploymentSafeguards(unittest.TestCase):
    def test_zero_gpu_public_torch_version_pin_is_supported(self):
        # The real Hub config validator rejected ==2.10.0+cu128 before build.
        lines = (ROOT / "deploy/huggingface-sam3/requirements.txt").read_text().splitlines()
        torch_lines = [line for line in lines if line.startswith("torch==")]
        self.assertEqual(torch_lines, ["torch==2.10.0"])
        self.assertIn("torchvision==0.25.0", lines)
        self.assertIn("--extra-index-url https://download.pytorch.org/whl/cu128", lines)

    def test_space_system_packages_are_names_without_comments(self):
        # The real Space builder passes every token to apt via xargs.
        lines = (ROOT / "deploy/huggingface-sam3/packages.txt").read_text().splitlines()
        self.assertEqual(lines, ["build-essential"])

    def test_shared_core_is_not_ignored_in_the_space(self):
        content = (ROOT / "deploy/huggingface-sam3/.gitignore").read_text()
        self.assertNotIn("chroma_sam3_core.py", content.splitlines())

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.temporary = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="chroma-deployment-test-"))
        self.project = Path(self.temporary)
        self.deploy = self.project / "deploy" / "huggingface-sam3"
        self.deploy.mkdir(parents=True)
        self.core = self.project / "server" / "sam3" / "core.py"
        self.core.parent.mkdir(parents=True)
        self.core.write_text("# shared core fixture\n", encoding="utf-8")
        for name in deployment.SPACE_FILES:
            (self.deploy / name).write_text("# deployment fixture: " + name + "\n", encoding="utf-8")
        self.stack.enter_context(patch.object(deployment, "ROOT", self.project))
        self.stack.enter_context(patch.object(deployment, "DEPLOY", self.deploy))

    def run_main(self, api=None, deploy=False, repo="example/chroma-sam3"):
        report_file = self.project / "result.json"
        arguments = ["deploy_sam3_space.py", "--repo", repo, "--report", str(report_file)]
        if deploy:
            arguments.append("--deploy")
        hub = ModuleType("huggingface_hub")
        hub.HfApi = lambda: api
        hub.SpaceHardware = FakeHardware
        errors = ModuleType("huggingface_hub.errors")
        errors.RepositoryNotFoundError = NotFound
        stdout = io.StringIO()
        with patch.object(sys, "argv", arguments), patch.dict(sys.modules, {"huggingface_hub": hub, "huggingface_hub.errors": errors}), redirect_stdout(stdout):
            result = deployment.main()
        return result, json.loads(report_file.read_text(encoding="utf-8")), stdout.getvalue()

    def test_manifest_contains_only_explicit_allowlist(self):
        unwanted = {"sam3.pt", "photo.jpg", "uploaded.png", ".env", ".env.production", "deployment-status.json", "token", "chroma.apk"}
        for name in unwanted:
            (self.deploy / name).write_text(SYNTHETIC_SECRET, encoding="utf-8")
        for name in ["node_modules", "photos", "uploads", "models", ".cache", ".venv", "android"]:
            directory = self.deploy / name
            directory.mkdir()
            (directory / "private-content.txt").write_text(SYNTHETIC_SECRET, encoding="utf-8")
        entries = deployment.deployment_manifest()
        self.assertEqual({target for _, target in entries}, ALLOWED)
        self.assertTrue(all(source.resolve().is_relative_to(self.project.resolve()) for source, _ in entries))
        self.assertTrue(all(SYNTHETIC_SECRET.encode() not in source.read_bytes() for source, _ in entries))

    def test_dry_run_requires_no_account_or_network(self):
        result, report, stdout = self.run_main()
        self.assertEqual(result, 0)
        self.assertEqual(report["status"], "prepared_dry_run")
        self.assertEqual(report["requested_hardware"], "zero-a10g")
        self.assertFalse(report["paid_hardware_requested"])
        self.assertFalse(report["secret_values_read_or_uploaded"])
        self.assertFalse(report["real_cloud_verified"])
        self.assertEqual({entry["path"] for entry in report["files"]}, ALLOWED)
        self.assertEqual(json.loads(stdout), report)
        for source, target in deployment.deployment_manifest():
            entry = next(entry for entry in report["files"] if entry["path"] == target)
            self.assertEqual(entry["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(entry["bytes"], source.stat().st_size)

    def test_missing_required_files_fail_before_upload(self):
        for name in deployment.REQUIRED_FILES:
            source = self.deploy / name
            content = source.read_bytes()
            source.unlink()
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Required deployment file"):
                deployment.deployment_manifest()
            source.write_bytes(content)

    def test_missing_shared_core_fails(self):
        self.core.unlink()
        with self.assertRaisesRegex(ValueError, "Shared SAM"):
            deployment.deployment_manifest()

    def test_oversized_allowed_file_fails(self):
        (self.deploy / "app.py").write_bytes(b"x" * 2_000_001)
        with self.assertRaisesRegex(ValueError, "size/credential safeguards"):
            deployment.deployment_manifest()

    def test_literal_credential_is_rejected_and_never_echoed(self):
        (self.deploy / "app.py").write_text(SYNTHETIC_SECRET, encoding="utf-8")
        result, report, stdout = self.run_main()
        self.assertEqual(result, 1)
        self.assertEqual(report["status"], "preparation_or_hardware_check_failed")
        self.assertNotIn(SYNTHETIC_SECRET, stdout)
        self.assertNotIn("files", report)

    def test_symlink_is_rejected_before_read(self):
        original = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda source: source.name == "app.py" or original(source)):
            with self.assertRaisesRegex(ValueError, "regular files inside"):
                deployment.deployment_manifest()

    def test_outside_project_source_is_rejected(self):
        with patch.object(deployment, "ROOT", self.project / "different-project"):
            with self.assertRaisesRegex(ValueError, "Shared SAM"):
                deployment.deployment_manifest()
        with tempfile.TemporaryDirectory(prefix="chroma-outside-source-test-") as outside:
            outside_deploy = Path(outside)
            for name in deployment.REQUIRED_FILES:
                (outside_deploy / name).write_text("# outside fixture", encoding="utf-8")
            with patch.object(deployment, "DEPLOY", outside_deploy):
                with self.assertRaisesRegex(ValueError, "regular files inside"):
                    deployment.deployment_manifest()

    def test_staged_upload_is_exact_allowlist_and_metadata_only(self):
        api = FakeApi()
        result, report, stdout = self.run_main(api, deploy=True)
        self.assertEqual(result, 0)
        self.assertEqual(report["status"], "uploaded_awaiting_build")
        self.assertEqual(set(api.uploads[0]), ALLOWED)
        self.assertTrue(all(SYNTHETIC_SECRET.encode() not in content for content in api.uploads[0].values()))
        self.assertNotIn(SYNTHETIC_SECRET, stdout)
        self.assertTrue(report["required_secret_present"])
        self.assertTrue(report["remote_manifest_verified"])
        staged = next(call[1]["folder_path"] for call in api.calls if call[0] == "upload_folder")
        self.assertFalse(Path(staged).exists(), "Only the freshly created upload staging directory is cleaned up")
        self.assertFalse(any(call[0] in {"request_space_hardware", "add_space_secret"} for call in api.calls))

    def test_remote_ignored_core_is_reported_as_incomplete_upload(self):
        class IgnoredCoreApi(FakeApi):
            def list_repo_files(self, repo, **kwargs):
                return [name for name in super().list_repo_files(repo, **kwargs) if name != "chroma_sam3_core.py"]
        result, report, _ = self.run_main(IgnoredCoreApi(), deploy=True)
        self.assertEqual(result, 1)
        self.assertEqual(report["status"], "preparation_or_hardware_check_failed")
        self.assertIn("chroma_sam3_core.py", report["message"])
        self.assertNotIn("remote_manifest_verified", report)

    def test_new_space_requests_only_public_gradio_zerogpu(self):
        api = FakeApi(missing=True)
        result, report, _ = self.run_main(api, deploy=True)
        self.assertEqual(result, 0)
        created = next(value for name, value in api.calls if name == "create_repo")
        self.assertEqual(created, {"repo_id": "example/chroma-sam3", "repo_type": "space", "space_sdk": "gradio", "space_hardware": "zero-a10g", "private": False})
        self.assertFalse(report["paid_hardware_requested"])

    def test_missing_secret_reports_manual_step_without_setting_it(self):
        api = FakeApi(secret=False)
        result, report, _ = self.run_main(api, deploy=True)
        self.assertEqual(result, 0)
        self.assertEqual(report["status"], "manual_hf_token_secret_required")
        self.assertFalse(report["required_secret_present"])

    def test_paid_actual_or_requested_hardware_always_aborts(self):
        for hardware, requested in [("t4-small", "zero-a10g"), ("zero-a10g", "t4-small"),
                                    ("cpu-upgrade", "zero-a10g"), ("zero-a10g", "a10g-large"), ("h100", "h100"),
                                    ("unknown-future-gpu", "zero-a10g")]:
            api = FakeApi(hardware=hardware, requested=requested)
            with self.subTest(hardware=hardware, requested=requested):
                result, report, _ = self.run_main(api, deploy=True)
                self.assertEqual(result, 1)
                self.assertEqual(report["status"], "preparation_or_hardware_check_failed")
                self.assertEqual(api.uploads, [])

    def test_free_transition_to_zerogpu_is_allowed(self):
        for hardware, requested in [(None, "zero-a10g"), ("cpu-basic", "zero-a10g"), ("zero-a10g", None)]:
            with self.subTest(hardware=hardware, requested=requested):
                result, report, _ = self.run_main(FakeApi(hardware=hardware, requested=requested), deploy=True)
                self.assertEqual(result, 0)
                self.assertEqual(report["status"], "uploaded_awaiting_build")

    def test_existing_nonpublic_or_other_sdk_aborts(self):
        for api in [FakeApi(private=True), FakeApi(sdk="docker")]:
            result, report, _ = self.run_main(api, deploy=True)
            self.assertEqual(result, 1)
            self.assertEqual(report["status"], "preparation_or_hardware_check_failed")
            self.assertEqual(api.uploads, [])

    def test_free_cpu_without_requested_zerogpu_requires_manual_action(self):
        api = FakeApi(hardware="cpu-basic", requested=None)
        result, report, _ = self.run_main(api, deploy=True)
        self.assertEqual(result, 1)
        self.assertEqual(report["status"], "preparation_or_hardware_check_failed")
        self.assertEqual(api.uploads, [])
        self.assertFalse(any(name == "create_repo" for name, _ in api.calls))

    def test_safe_api_error_never_includes_http_body_headers_or_exception(self):
        for status, expected in [(402, "payment_or_account_eligibility_required"), (401, "manual_login_or_space_creation_required"),
                                 (403, "manual_login_or_space_creation_required"), (500, "deployment_api_error")]:
            error = RuntimeError("private user content " + SYNTHETIC_SECRET)
            error.response = SimpleNamespace(status_code=status, text=SYNTHETIC_SECRET, headers={"Authorization": SYNTHETIC_SECRET})
            self.assertEqual(deployment.safe_error(error), {"status": expected, "http_status": status, "error_type": "RuntimeError"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
