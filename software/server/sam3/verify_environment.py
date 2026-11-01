"""Verify the dedicated Linux SAM 3 runtime without loading model weights.

Run from the project root inside its Python 3.12+ environment:
    python -m server.sam3.verify_environment --output server/sam3/environment-verification.json
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import importlib
from importlib import metadata
import io
import json
from pathlib import Path
import platform
import re
import sys
import time

PINNED_SAM3_COMMIT = "0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc"
MIB = 1024 * 1024


class EnvironmentCheckError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def version_pair(value: str) -> tuple[int, int] | None:
    match = re.match(r"^(\d+)\.(\d+)", value)
    return tuple(map(int, match.groups())) if match else None


def package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def sam3_installation() -> dict:
    """Read only VCS revision metadata; never emit repository URLs or credentials."""
    actual_commit = None
    requested_revision = None
    try:
        distribution = metadata.distribution("sam3")
        direct_url = json.loads(distribution.read_text("direct_url.json") or "{}")
        vcs = direct_url.get("vcs_info", {})
        candidate = vcs.get("commit_id")
        if isinstance(candidate, str) and re.fullmatch(r"[0-9a-fA-F]{40}", candidate):
            actual_commit = candidate.lower()
        candidate = vcs.get("requested_revision")
        if isinstance(candidate, str) and re.fullmatch(r"[0-9a-fA-F]{40}", candidate):
            requested_revision = candidate.lower()
    except (metadata.PackageNotFoundError, ValueError, AttributeError, TypeError):
        pass
    return {
        "version": package_version("sam3"),
        "expected_commit": PINNED_SAM3_COMMIT,
        "installed_vcs_commit": actual_commit,
        "requested_vcs_revision": requested_revision,
        "matches_expected_commit": actual_commit == PINNED_SAM3_COMMIT if actual_commit else None,
    }


def check_environment() -> dict:
    report = {
        "ok": False,
        "platform": sys.platform,
        "python": platform.python_version(),
        "stage": "platform",
        "versions": {},
        "sam3": {"expected_commit": PINNED_SAM3_COMMIT},
        "model_weights_loaded": False,
        "model_download_attempted": False,
    }
    try:
        if sys.platform != "linux":
            raise EnvironmentCheckError("linux_required", "Run this diagnostic inside the dedicated Linux/WSL2 environment, not Windows Python.")
        if sys.version_info < (3, 12):
            raise EnvironmentCheckError("python_version", "Use Python 3.12 or newer in server/sam3/.venv-linux.")

        modules = {}
        for name in ("torch", "torchvision", "triton", "einops", "psutil", "pkg_resources", "sam3"):
            report["stage"] = "import:" + name
            # The result stays parseable JSON even if an upstream import prints
            # notices. Captured output is discarded, never logged or persisted.
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                modules[name] = importlib.import_module(name)
            distribution_name = "setuptools" if name == "pkg_resources" else name
            report["versions"][distribution_name] = package_version(distribution_name)

        report["stage"] = "import:sam3.model_builder"
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            builder = importlib.import_module("sam3.model_builder")
            processor = importlib.import_module("sam3.model.sam3_image_processor")
        if not callable(getattr(builder, "build_sam3_image_model", None)) or not callable(getattr(processor, "Sam3Processor", None)):
            raise EnvironmentCheckError("sam3_api", "The installed SAM 3 package does not expose the required builder and Sam3Processor. Reinstall the pinned Meta commit.")
        report["sam3"] = sam3_installation()
        if report["sam3"]["matches_expected_commit"] is False:
            raise EnvironmentCheckError("sam3_revision", "The installed SAM 3 VCS revision differs from the documented pin. Reinstall the exact Meta commit before loading the checkpoint.")

        report["stage"] = "cuda:availability"
        torch = modules["torch"]
        torch_version = version_pair(torch.__version__)
        if not torch_version or torch_version < (2, 7):
            raise EnvironmentCheckError("torch_version", "Install CUDA PyTorch 2.7 or newer using the documented dedicated environment.")
        cuda_version = version_pair(torch.version.cuda or "")
        report["torch_cuda_runtime"] = torch.version.cuda
        if not cuda_version or cuda_version < (12, 6):
            raise EnvironmentCheckError("cuda_runtime", "Install a CUDA-enabled PyTorch build with CUDA runtime 12.6 or newer; CPU-only PyTorch cannot run this service.")
        if not torch.cuda.is_available():
            raise EnvironmentCheckError("cuda_unavailable", "PyTorch cannot access CUDA. Check the NVIDIA driver, WSL2 GPU access and the installed CUDA PyTorch wheel.")

        report["stage"] = "cuda:compute"
        device_index = torch.cuda.current_device()
        device = torch.device("cuda", device_index)
        torch.cuda.synchronize(device)
        torch.cuda.reset_peak_memory_stats(device)
        started = time.perf_counter()
        cpu_input = torch.arange(256, dtype=torch.float32).reshape(16, 16)
        gpu_input = cpu_input.to(device)
        gpu_output = gpu_input @ gpu_input.T
        torch.cuda.synchronize(device)
        elapsed_seconds = time.perf_counter() - started
        torch.testing.assert_close(gpu_output.cpu(), cpu_input @ cpu_input.T, rtol=0, atol=0)

        free_bytes, total_bytes = torch.cuda.mem_get_info(device)
        properties = torch.cuda.get_device_properties(device)
        report["gpu"] = {
            "index": device_index,
            "name": properties.name,
            "compute_capability": [properties.major, properties.minor],
            "total_mib": round(total_bytes / MIB, 3),
            "free_mib": round(free_bytes / MIB, 3),
            "allocated_mib": round(torch.cuda.memory_allocated(device) / MIB, 3),
            "reserved_mib": round(torch.cuda.memory_reserved(device) / MIB, 3),
            "peak_allocated_mib": round(torch.cuda.max_memory_allocated(device) / MIB, 3),
            "peak_reserved_mib": round(torch.cuda.max_memory_reserved(device) / MIB, 3),
            "bf16_supported": bool(torch.cuda.is_bf16_supported()),
        }
        report["compute"] = {
            "operation": "16x16 float32 matrix multiplication on CUDA",
            "correctness": "exact match with CPU reference",
            "elapsed_seconds": round(elapsed_seconds, 6),
            "includes": "host-to-device copy and synchronized CUDA matrix multiplication",
        }
        del gpu_input, gpu_output, cpu_input
        torch.cuda.synchronize(device)
        report["ok"] = True
        report["stage"] = "complete"
        report["message"] = "Imports and real CUDA computation passed. Model loading and segmentation must be verified separately."
    except EnvironmentCheckError as error:
        report["error"] = {"code": error.code, "message": str(error)}
    except Exception as error:
        # Exception strings can contain arbitrary paths/data. Report only a safe
        # exception class and, for import errors, a validated module identifier.
        if report["stage"].startswith("import:"):
            message = "A required runtime import failed. Activate .venv-linux, install server/sam3/requirements.txt and the pinned Meta package, then run pip check. For torchvision failures, install the matching CUDA torch/torchvision pair."
            code = "dependency_import"
        elif isinstance(error, AssertionError):
            message = "The CUDA result did not match its CPU reference. Check the GPU driver and PyTorch installation before loading the model."
            code = "cuda_correctness"
        else:
            message = "CUDA initialization or computation failed. Check WSL GPU access, driver compatibility and available GPU memory."
            code = "cuda_compute"
        report["error"] = {"code": code, "exception": type(error).__name__, "message": message}
        missing = getattr(error, "name", None)
        if isinstance(missing, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", missing):
            report["error"]["missing_module"] = missing
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Optional local JSON result file. Does not include tokens or authentication state.")
    arguments = parser.parse_args()
    report = check_environment()
    if arguments.output:
        try:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        except OSError as error:
            report["ok"] = False
            report["error"] = {"code": "output_write", "exception": type(error).__name__, "message": "Could not write the requested JSON record. Choose a writable output directory."}
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
