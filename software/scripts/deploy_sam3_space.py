"""Upload only the CHROMA Gradio deployment and shared SAM code to free ZeroGPU.

Run inside the authenticated WSL environment. Secrets are configured manually
in Space Settings; this script never reads, sets or prints their values.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "huggingface-sam3"
ZERO_GPU = "zero-a10g"  # HF's legacy identifier for dynamically allocated ZeroGPU.
SPACE_FILES = ("app.py", "adapter.py", "space_adapter.py", "service.py", "requirements.txt", "packages.txt", "README.md", ".gitignore")
REQUIRED_FILES = {"app.py", "requirements.txt", "README.md", ".gitignore"}
SECRET_LITERAL = re.compile(rb"hf_[A-Za-z0-9]{20,}")


def deployment_manifest() -> list[tuple[Path, str]]:
    entries = []
    for name in SPACE_FILES:
        source = DEPLOY / name
        if name in REQUIRED_FILES and not source.is_file():
            raise ValueError("Required deployment file is missing: " + name)
        if source.is_file():
            entries.append((source, name))
    core = ROOT / "server" / "sam3" / "core.py"
    if not core.is_file():
        raise ValueError("Shared SAM validation/inference core is missing.")
    entries.append((core, "chroma_sam3_core.py"))
    for source, target in entries:
        if source.is_symlink() or not source.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("Deployment files must be regular files inside this project.")
        data = source.read_bytes()
        if len(data) > 2_000_000 or SECRET_LITERAL.search(data):
            raise ValueError("Deployment file failed size/credential safeguards: " + target)
    return entries


def safe_error(error: Exception) -> dict:
    status = getattr(getattr(error, "response", None), "status_code", None)
    if status == 402:
        action = "payment_or_account_eligibility_required"
    elif status in (401, 403):
        action = "manual_login_or_space_creation_required"
    else:
        action = "deployment_api_error"
    # Do not print the HTTP body, request headers, exception string or auth data.
    return {"status": action, "http_status": status, "error_type": type(error).__name__}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Public Hugging Face owner/space identifier.")
    parser.add_argument("--deploy", action="store_true", help="Create/reuse a ZeroGPU Space and upload the strict file manifest.")
    parser.add_argument("--report", type=Path, default=ROOT / "deploy" / "huggingface-sam3" / "deployment-status.json")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", args.repo):
        parser.error("Use an owner/space identifier, without credentials or a URL.")
    report = {"repo": args.repo, "space_url": "https://huggingface.co/spaces/" + args.repo,
              "requested_hardware": ZERO_GPU, "paid_hardware_requested": False,
              "secret_values_read_or_uploaded": False, "real_cloud_verified": False}
    try:
        entries = deployment_manifest()
        report["files"] = [{"path": target, "bytes": source.stat().st_size,
                             "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
                            for source, target in entries]
        if not args.deploy:
            report["status"] = "prepared_dry_run"
        else:
            from huggingface_hub import HfApi, SpaceHardware
            from huggingface_hub.errors import RepositoryNotFoundError
            api = HfApi()
            try:
                info = api.space_info(args.repo)
            except RepositoryNotFoundError:
                api.create_repo(repo_id=args.repo, repo_type="space", space_sdk="gradio",
                                space_hardware=SpaceHardware.ZERO_A10G, private=False)
                info = api.space_info(args.repo)
            if info.sdk != "gradio" or info.private:
                raise ValueError("Existing Space must be public and use the Gradio SDK.")
            runtime = api.get_space_runtime(args.repo)
            hardware_states = (runtime.hardware, runtime.requested_hardware)
            if any(value not in (None, "cpu-basic", ZERO_GPU) for value in hardware_states):
                raise ValueError("Existing Space has nonfree or unknown hardware. No upload or hardware change was attempted.")
            if ZERO_GPU not in hardware_states:
                raise ValueError("Existing Space is not ZeroGPU. Select ZeroGPU manually; no hardware upgrade was attempted.")
            report.update(hardware=runtime.hardware, requested_hardware=runtime.requested_hardware)
            stage_base = ROOT / ".tools"
            stage_base.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="chroma-space-stage-", dir=stage_base) as directory:
                stage = Path(directory)
                # TemporaryDirectory cleanup is limited to this freshly created
                # child of the project's tools folder, never a computed outside path.
                assert stage.resolve().is_relative_to(stage_base.resolve())
                for source, target in entries:
                    shutil.copyfile(source, stage / target)
                commit = api.upload_folder(repo_id=args.repo, repo_type="space", folder_path=str(stage),
                                           commit_message="Add CHROMA official SAM 3 ZeroGPU adapter")
            report["commit"] = commit.oid
            # The Hub applies the uploaded .gitignore during commits. A staged
            # manifest alone cannot prove shared code actually reached the repo.
            uploaded = set(api.list_repo_files(args.repo, repo_type="space", revision=commit.oid))
            missing = {target for _, target in entries} - uploaded
            if missing:
                raise ValueError("Uploaded Space is missing required manifest files: " + ", ".join(sorted(missing)))
            report["remote_manifest_verified"] = True
            secrets = api.get_space_secrets(args.repo)
            report["required_secret_present"] = "HF_TOKEN" in secrets
            report["status"] = "uploaded_awaiting_build" if report["required_secret_present"] else "manual_hf_token_secret_required"
    except Exception as error:
        if isinstance(error, ValueError):
            report.update(status="preparation_or_hardware_check_failed", message=str(error))
        else:
            report.update(safe_error(error))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] in ("prepared_dry_run", "uploaded_awaiting_build", "manual_hf_token_secret_required") else 1


if __name__ == "__main__":
    sys.exit(main())
