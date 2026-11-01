"""Check CHROMA sources/build/APK for HF credential literals without displaying them.

This is a static safeguard, not a universal guarantee against every secret type.
It does not open the Hugging Face credential store or environment secret values.
"""
from pathlib import Path
import hashlib
import json
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOKEN = re.compile(rb"hf_[A-Za-z0-9]{20,}")
MODEL_SUFFIXES = (".pt", ".pth", ".safetensors")


def main():
    failures = []
    counts = {}
    for directory in ("src", "dist"):
        files = [file for file in (ROOT / directory).rglob("*") if file.is_file()]
        counts[directory] = len(files)
        for file in files:
            if TOKEN.search(file.read_bytes()) or file.name.endswith(MODEL_SUFFIXES):
                failures.append(str(file.relative_to(ROOT)))
    apk = ROOT / "android/app/build/outputs/apk/debug/app-debug.apk"
    if not apk.is_file():
        raise SystemExit("Build the debug APK before the client audit.")
    with zipfile.ZipFile(apk) as archive:
        counts["apk_entries"] = len(archive.infolist())
        for entry in archive.infolist():
            if not entry.is_dir() and (entry.filename.endswith(MODEL_SUFFIXES) or TOKEN.search(archive.read(entry))):
                failures.append("apk:" + entry.filename)
        web = b"".join(archive.read(name) for name in archive.namelist() if name.startswith("assets/public/") and name.endswith(".js"))
        configured_space_present = b"Vizhodhan/chroma-sam3" in web
        fixture_space_absent = b"chroma-ui-fixture.hf.space" not in web
    report = {
        "passed": not failures and configured_space_present and fixture_space_absent,
        "credential_literal_or_checkpoint_file_findings": failures,
        "scanned": counts,
        "configured_public_space_in_apk": configured_space_present,
        "mock_fixture_space_absent_from_apk": fixture_space_absent,
        "apk_path": str(apk.relative_to(ROOT)),
        "apk_bytes": apk.stat().st_size,
        "apk_sha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
        "credential_store_read": False,
        "scope": "HF-style credential literal and checkpoint filename scan; no secret values printed.",
    }
    output = ROOT / "artifacts/cloud-sam3-ui/client-audit.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
