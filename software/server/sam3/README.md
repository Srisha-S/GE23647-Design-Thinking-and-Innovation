# CHROMA local SAM 3 server

Visualize can send a tap and its resized photo to this optional server, then
apply the returned surface mask in CHROMA's local recolouring engine. The server
calls Meta's real SAM 3 image model. It does not regenerate photographs, infer
materials, change scanned colour values or create fallback masks.

The integration and HTTP contract are implemented and tested with an injected
predictor. The real model environment is now installed separately in Ubuntu
24.04 WSL2: Python 3.12.3, PyTorch 2.10.0+cu128 and the pinned official SAM 3
package. Full model imports and actual CUDA computation pass on the RTX 4060.
**The official checkpoint has now been downloaded, `/health` reports
`ready: true`, and real HTTP segmentation plus CHROMA Visualize integration
have passed.** Confirmed results and reproduction commands are recorded below.
The 8 GB GPU handled the tested 1200 x 800 photo; larger images and other GPU
workloads still need memory headroom. Existing manual and local selection paths
have not been changed and were verified alongside the real SAM result.

## Model environment

Meta specifies Python 3.12+, PyTorch 2.7+ and a CUDA GPU with CUDA 12.6+.
**Use Linux or WSL2 for the model runtime.** The pinned upstream image builder
imports a Triton kernel through its tracker modules, so a native Windows CUDA
PyTorch installation alone does not provide the complete model environment.
The Windows HTTP service and protocol tests are supported without installing
the model. Linux/WSL2 imports, CUDA and real image inference have been verified.

Use a separate environment so this does not alter CHROMA's Node/Android setup.
Follow [Meta's installation instructions](https://github.com/facebookresearch/sam3#installation)
and, for WSL2, [Microsoft's CUDA setup guide](https://learn.microsoft.com/en-us/windows/ai/directml/gpu-cuda-in-wsl).
The example below assumes an installed Ubuntu 24.04 WSL2 distribution with GPU
access. For another Linux distribution, install Python 3.12 and Git using its
package manager and run the remaining commands from your project root.

In the **Ubuntu/WSL terminal**, not PowerShell:

```bash
nvidia-smi || /usr/lib/wsl/lib/nvidia-smi
sudo apt-get update
sudo apt-get install -y python3.12 python3.12-venv python3.12-dev git build-essential
cd /mnt/e/Clg/sem5/di/chroma/website
python3.12 -m venv server/sam3/.venv-linux
source server/sam3/.venv-linux/bin/activate
mkdir -p server/sam3/.runtime-tmp server/sam3/.runtime-cache
export TMPDIR="$(pwd)/server/sam3/.runtime-tmp"
export HF_HOME="$(pwd)/server/sam3/.runtime-cache/huggingface"
python -m pip install --no-cache-dir --upgrade pip
python -m pip install --no-cache-dir torch==2.10.0 torchvision --index-url https://download.pytorch.org/whl/cu128
python -m pip install --no-cache-dir -r server/sam3/requirements.txt
python -m pip install --no-cache-dir "git+https://github.com/facebookresearch/sam3.git@0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc"
python -m pip check
python -c "import torch, triton, einops, psutil, pkg_resources, sam3; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
python -m server.sam3.verify_environment --output server/sam3/environment-verification.json
```

`verify_environment` imports the actual image builder and processor as well as
their runtime dependencies, executes a small CUDA matrix multiplication and
checks its result against a CPU reference. It reports safe JSON versions,
installed SAM VCS revision when available, GPU identity/memory and synchronized
compute time. It exits nonzero on setup errors. This diagnostic neither loads
weights nor downloads a model; a passing result is a prerequisite for the real
segmentation test, not evidence of model accuracy or speed.

`python3.12-dev` supplies `Python.h` for Triton's native CUDA helper compilation.
A real inference initially exposed these missing headers; after installation,
the same request passed without skipping mask post-processing.

The pinned Meta commit is the source inspected for this adapter. The requirements
include `einops`, `psutil` and `pycocotools`, which this commit imports but does
not list in its base dependencies. The actual image-builder import exposed the
missing `pycocotools` dependency through the tracker, training collator and COCO
loader; adding it fixed that verified import failure. The requirements also pin
`setuptools<82` because upstream still imports
`pkg_resources`, which [Setuptools removed in version 82](https://setuptools.pypa.io/en/stable/deprecated/pkg_resources.html).
Keep the Windows and Linux virtual environments separate. Stop here if the import
check fails or CUDA reports `False`; do not proceed with an unconfigured model.

On a fresh WSL distribution the CLI may initially run as root. The verified
package installation used `apt-get` directly in that case; the copied `sudo`
commands above are for a regular Linux user. The `/usr/lib/wsl/lib/nvidia-smi`
fallback is needed when the WSL GPU utility is absent from `PATH`.

Large installation files belong on the project drive when Windows C: space is
limited. `TMPDIR` directs temporary wheel extraction to the project's E: path,
and `--no-cache-dir` avoids retaining duplicate pip wheels in the WSL system
disk. `HF_HOME` keeps Hugging Face downloads and local authentication state in
the ignored runtime cache. Reuse the same value when authenticating, downloading
and starting a new session; do not publish its token files.

Request checkpoint access at [facebook/sam3](https://huggingface.co/facebook/sam3),
accept its terms and wait for access approval. After authenticating locally with
`hf auth login`, download the official **SAM 3 `sam3.pt`** checkpoint:

In the same activated **Linux/WSL terminal**, after access approval:

```bash
hf auth login
hf download facebook/sam3 sam3.pt --local-dir server/sam3/models
export CHROMA_SAM3_CHECKPOINT="$(realpath server/sam3/models/sam3.pt)"
python -m uvicorn server.sam3.app:app --host 127.0.0.1 --port 8001 --workers 1
```

The service never downloads weights automatically. Do not use the separate
SAM 3.1 video multiplex checkpoint with this image adapter. Keep one worker:
each process loads a GPU model, and simultaneous image requests are rejected
with a retry message while inference is busy.

Open `http://127.0.0.1:8001/health`. It must return `ready: true` before selecting
SAM 3 in Visualize. Choose SAM 3 in the existing selection controls, enter
`http://127.0.0.1:8001` as the server URL, and tap the surface. Loading, absent
weights, no matching object, invalid masks and inference errors are reported
without substituting an invented SAM result.

For each new terminal session, reactivate `.venv-linux` and set
`TMPDIR`, `HF_HOME` and `CHROMA_SAM3_CHECKPOINT` again before starting the service.
With WSL, also verify
that Windows can reach it before configuring the web app or Android forwarding:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health
```

This depends on WSL localhost forwarding; if it fails, fix WSL networking first
rather than exposing the unauthenticated service to the network.

## Windows HTTP-only setup

To run the API diagnostics and tests on the existing Python 3.11 Windows
installation without a model, use this separate environment from the project
root. Full paths avoid PowerShell activation policy problems:

```powershell
python -m venv server/sam3/.venv-http
server/sam3/.venv-http/Scripts/python.exe -m pip install -r server/sam3/requirements.txt
server/sam3/.venv-http/Scripts/python.exe -m unittest server.sam3.test_server -v
server/sam3/.venv-http/Scripts/python.exe -m uvicorn server.sam3.app:app --host 127.0.0.1 --port 8001 --workers 1
```

Without `CHROMA_SAM3_CHECKPOINT`, `/health` correctly reports `ready: false` and
selection returns HTTP 503. Do not start this diagnostic instance on port 8001
at the same time as the WSL model service; use another port when testing both.

## Android connection

An Android phone's `localhost` is the phone itself. For a USB-connected Android
debug session, enable USB debugging, authorize the connected computer, and first
verify the PC's `/health` response. Run these in **Windows PowerShell**, using
Windows ADB, to forward the service without exposing it to the network:

```powershell
& "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" devices
& "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" reverse tcp:8001 tcp:8001
```

Keep the PC server running and use `http://127.0.0.1:8001` in Visualize. Actual
phone forwarding and model inference still need device verification. With WSL,
Windows localhost access must work first; the server remains in the WSL terminal.
Reapply `adb reverse` after reconnecting the phone. For a
remote server, use an authenticated HTTPS proxy configured for your deployment;
do not bind this unauthenticated development service publicly. An HTTPS web app
must use an HTTPS endpoint to avoid mixed-content restrictions.

## HTTP contract

`GET /health` returns `{ready, model: "sam3", message}`. An unconfigured service
stays reachable for diagnostics but returns HTTP 503 from `/segment`.

`POST /segment`, `Content-Type: application/json`:

```json
{
  "image": "data:image/png;base64,...",
  "width": 1200,
  "height": 800,
  "points": [{"x": 410, "y": 320, "label": 1}],
  "text": "curtain"
}
```

Text is optional. Points are pixel coordinates in this exact decoded image.
Label 1 selects foreground; label 0 excludes background. At least one positive
point is required. The service supports up to 32 points and a 120-character text
description. With text, it chooses the highest-scoring concept mask containing
the requested positive points and excluding negative points. Without text, it
uses the interactive instance predictor and selects the best valid candidate.
It never unions unrelated objects.

Successful response:

```json
{"width":1200,"height":800,"model":"sam3","score":0.91,"mask_base64":"..."}
```

`mask_base64` is base64-encoded **raw uint8 alpha bytes**, not a PNG. Decode to
exactly `width × height` bytes in row-major order. 0 is unselected, 255 selected.
The client validates geometry and byte count before applying the mask.

The original model calls are verified against Meta's
[builder](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model_builder.py),
[image processor](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model/sam3_image_processor.py),
[instance dispatch](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model/sam3_image.py)
and [point predictor](https://github.com/facebookresearch/sam3/blob/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/sam3/model/sam1_task_predictor.py).
The builder enables `enable_inst_interactivity=True`; the tap path uses
`processor.set_image(image)` followed by `model.predict_inst(state,
point_coords=..., point_labels=..., multimask_output=True)`.

## Limits, privacy and diagnostics

PNG/JPEG/WebP still images only; decoded geometry must match the request and
cannot exceed 2048 pixels on either edge. Encoded image bytes are limited to
8 MB and the entire streamed request body to 12 MB. Photo bytes and embeddings
are released after each request, responses have `Cache-Control: no-store`,
and validation errors do not echo submitted images. Model state alone remains
in memory. The browser sends the photo only when the user chooses SAM 3.

Allowed browser origins include CHROMA's local 8000/4173/5173 development and
preview URLs plus Capacitor's `http://localhost`, `https://localhost` and
`capacitor://localhost`. Other Origins and Host headers are rejected. Add exact
origins or hostnames through comma-separated `CHROMA_SAM3_ORIGINS` and
`CHROMA_SAM3_HOSTS` only when deliberately deploying on a different address.
Wildcards are rejected. These controls are not authentication.

HTTP 413: body/image too large. HTTP 415: content type. HTTP 422: invalid request,
image mismatch or no suitable mask. HTTP 502: invalid provider output. HTTP 503:
model unavailable, busy or inference failed. `/health` explains setup failures;
server logs contain initialization diagnostics and inference exception classes,
never submitted photographs. There is no `localStorage` access or data migration.

Run the isolated regression tests from the project root:

```powershell
python -m unittest server.sam3.test_server -v
```

These verify the HTTP contract, strict inputs, dimensions, limits, CORS,
unavailable/busy/error behaviour, mask selection, official adapter call shape
and embedding cleanup. They are not evidence of real model accuracy or speed.

## Runtime setup progress — 7 October 2026

The following facts were confirmed during preparation of the real local runtime:

- Installed `Ubuntu-24.04` with
  `wsl.exe --install -d Ubuntu-24.04 --no-launch --web-download`.
  `wsl.exe --list --verbose` confirms that this distribution uses WSL version 2.
- Distribution reports Ubuntu 24.04.5 and Python 3.12.3. Fresh noninteractive
  CLI commands run as UID 0; no interactive Linux user setup or login was
  automated.
- Plain `nvidia-smi` was absent from `PATH`.
  `/usr/lib/wsl/lib/nvidia-smi` successfully reports an NVIDIA GeForce RTX 4060,
  8188 MiB VRAM, driver 572.61 and CUDA 12.8. Observed baseline GPU usage was
  1642 MiB; that is an observation, not a model memory benchmark.
- `apt-get update` and installation of `python3.12`, `python3.12-venv`, `git`
  and `build-essential` completed successfully.
- After package installation, one WSL `CreateInstance` call returned
  `HCS_E_CONNECTION_TIMEOUT`. A single `wsl.exe --shutdown` recovered it;
  subsequent Python version checks and virtual-environment creation passed.
- Created the isolated project environment `server/sam3/.venv-linux` and
  upgraded its pip to 26.2.1. Native Windows Python was not used for the model.
- Observed free space was approximately 8.7 GB on C: and 466 GB on E:.
  Installation uses the project `.runtime-tmp` directory on E: and pip
  `--no-cache-dir`; `.runtime-tmp` and `.runtime-cache` are ignored by Git.
- Before the later download, neither `server/sam3/models/sam3.pt` nor the standard
  Windows Hugging Face `models--facebook--sam3` cache was present.

### Installed runtime and verification

- Installed official CUDA wheels: `torch==2.10.0+cu128`,
  `torchvision==0.25.0+cu128`, `triton==3.6.0`; CUDA runtime reports 12.8.
- Installed `sam3==0.1.0` from the documented official Git commit
  `0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc`. Installed VCS metadata matches
  the requested pin.
- Installed the HTTP requirements, including `numpy==1.26.4`,
  `einops==0.8.2`, `psutil==7.2.2`, `setuptools==78.1.0` and
  `pycocotools==2.0.11`. The initial deep SAM import failed with
  `ModuleNotFoundError: No module named 'pycocotools'`; the requirements fix
  resolves it. No server adapter or app integration changes were necessary.
- `python -m pip check` passed. The diagnostic imports the actual SAM image
  builder and `Sam3Processor` successfully and confirms CUDA availability.
- `python -m server.sam3.verify_environment --output server/sam3/environment-verification.json`
  passed. A real 16 x 16 float32 CUDA matrix multiplication matched its CPU
  reference exactly. The measured 0.580088 seconds includes copying and
  synchronized computation; **this is not SAM inference latency**.
- At the CUDA probe, 7065 MiB of 8187.5 MiB GPU memory was free. The probe
  allocated 8.127 MiB and reserved 22 MiB at peak. At this preparation stage,
  weights were not loaded; these probe figures are separate from the later
  real segmentation measurements below.
- `python -m unittest server.sam3.test_server -v` passed all 11 existing server
  tests in the Linux environment. These tests use injected predictors and
  cannot establish real model accuracy, memory usage or readiness.

Machine-readable results: [environment-verification.json](environment-verification.json)
and [checkpoint-access-verification.json](checkpoint-access-verification.json).

### Checkpoint authentication history and manual setup

An unauthenticated metadata request to the official `facebook/sam3` repository
returned `GatedRepoError`, HTTP 401. No credentials were configured in the
project's Linux Hugging Face cache, no checkpoint was present, and no model
download was attempted. Setup stopped at this manual prerequisite as requested.

On the first continuation, the official metadata check again returned
HTTP 401 with no local checkpoint and no configured project-cache login.
The default Linux authentication cache and standard Windows token location
also had no configured credentials. The same manual prerequisite remains;
the access diagnostic was refreshed without downloading or exposing tokens.
On the next continuation, the user's local login and approved access were
available. The official metadata probe passed and the official checkpoint was
downloaded using the commands above. The manual instructions below are retained
for setting up another account or machine; they are no longer a blocker here.

1. Open [the official facebook/sam3 model page](https://huggingface.co/facebook/sam3)
   and log in to Hugging Face. Review the model's access conditions and contact
   information sharing form, request access, and wait for approval.
2. Open the installed Ubuntu shell from **Windows PowerShell**:

   ```powershell
   wsl.exe -d Ubuntu-24.04 --cd /mnt/e/Clg/sem5/di/chroma/website --exec bash
   ```

3. In that **Ubuntu shell**, authenticate manually using the same runtime cache:

   ```bash
   source server/sam3/.venv-linux/bin/activate
   export HF_HOME="$PWD/server/sam3/.runtime-cache/huggingface"
   hf auth login
   hf auth whoami
   ```

   Choose **Log in with your browser**. Open the URL printed by the CLI, enter
   its displayed code and approve the request yourself. The current CLI
   supports this [browser/device login flow](https://huggingface.co/docs/huggingface_hub/guides/cli).
   If you choose token login instead, create a read token for your approved
   account and paste it only into the local CLI prompt, never into chat or
   tracked files. Browser approval does not replace gated model-access approval.

After both access approval and local authentication, resume setup with the
official download/start commands above. Reuse `HF_HOME`; set
`CHROMA_SAM3_CHECKPOINT` to the downloaded official `sam3.pt` path.

### Real runtime verification — 7 October 2026

The official `sam3.pt` file is stored at `server/sam3/models/sam3.pt`.
It contains **3,450,062,241 bytes**. Its SHA-256 matches the official download
metadata:

```text
9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e
```

The resolved Hugging Face repository revision was
`3c879f39826c281e95690f02c7821c4de09afae7`.
Only the official `facebook/sam3` checkpoint was used. Authentication tokens
were neither printed nor included in tracked result files.

Launched the existing adapter in the Linux environment, from the project root:

```bash
source server/sam3/.venv-linux/bin/activate
export TMPDIR="$PWD/server/sam3/.runtime-tmp"
export HF_HOME="$PWD/server/sam3/.runtime-cache/huggingface"
export CHROMA_SAM3_CHECKPOINT="$PWD/server/sam3/models/sam3.pt"
python -m uvicorn server.sam3.app:app --host 127.0.0.1 --port 8001 --workers 1
```

- `/health` returned `{"ready":true,"model":"sam3","message":"SAM 3 is ready."}`
  from both WSL and Windows. `ss -ltnp` confirms the actual Linux listener is
  **127.0.0.1:8001**, not a public interface.
- Used Meta's real [truck photograph](https://raw.githubusercontent.com/facebookresearch/sam3/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/assets/images/truck.jpg)
  (1800 x 1200, 271475 bytes), resized to 1200 x 800. The positive point
  `(733,373)` lies on the cab door; text was omitted to match the UI tap path.
- `/segment` returned HTTP 200, `model: sam3`, score 0.84765625, and exactly
  **960000 raw uint8 alpha bytes**, matching the returned 1200 x 800 dimensions.
  The corrected post-processing result contains 41621 selected pixels (4.3355%)
  and includes the positive point. Its bytes contain only 0 and 255.
- First inference was 9.487647 seconds and exposed a `Python.h` compilation
  failure. Upstream caught it and skipped optional post-processing. Installed
  `python3.12-dev` (plus distro dependencies, 32.5 MB) and repeated the request:
  **13.814346 seconds**, including first native/Triton compilation. The repeat
  produced a valid mask without the skipped-post-processing warning.
  The local smoke-test command was
  `python server/sam3/.runtime-tmp/verify_real_request.py` in the activated WSL
  environment; it used the existing API contract and saved the compact result,
  mask and overlay under `artifacts/sam3-runtime`. This scratch probe is ignored
  by Git; the standalone tracked browser harness below also verifies the full
  real request/response geometry and byte count without mocks.
- Before loading, total observed GPU use was 1882 MiB. With the ready model,
  observed use was 7026 MiB. The sampled peak during the corrected real request
  was **7587 MiB of 8188 MiB**. These are whole-GPU `nvidia-smi` observations
  including Windows graphics/other processes, not model-only allocations;
  sampling can miss brief peaks. No CUDA out-of-memory error occurred.
- Existing server regression tests passed again: **11 tests**. An upstream
  `timm.models.layers` deprecation warning remains; it did not prevent loading
  or inference.

Results are preserved in
[`artifacts/sam3-runtime/http-initial-verification.json`](../../artifacts/sam3-runtime/http-initial-verification.json)
and [`http-verification.json`](../../artifacts/sam3-runtime/http-verification.json).
The mask and photographic overlay are stored beside those reports.

### Unmocked Visualize verification

Added a standalone verification harness that uses a fresh headless Chrome
profile and observes the real HTTP request through DevTools. It does not replace
`fetch`, inject a segmentation response or modify the app's saved workspace.
Run it from **Windows PowerShell**, with the app and model server running:

```powershell
python scripts/verify_real_sam3_ui.py --photo artifacts/sam3-runtime/truck.jpg --tap-x 0.6111111111 --tap-y 0.4666666667 --url http://127.0.0.1:8000 --server http://127.0.0.1:8001
```

The real run passed:

- Uploaded the genuine photo, selected a saved Library colour and configured
  the existing **Tap → SAM 3 object** option with the localhost URL.
- Observed exactly one uncached HTTP 200 `/segment` request. Its 1200 x 800
  mask had 960000 bytes, selected the tap and matched the displayed overlay.
- Applied the Library colour: selected pixels changed, while **zero unselected
  pixels changed** and the original alpha remained intact.
- Manual Brush and **Tap → Local colour region** both worked after the real
  SAM selection. Both Undo operations restored the original SAM overlay,
  without additional SAM uploads or changes to saved Library metadata.
- Warm browser requests took approximately **0.53–0.65 seconds** over the
  network; selection completion including reading the UI took approximately
  **1.03–1.59 seconds** across the two successful runs. The latest run additionally
  compared every rendered overlay byte after each Undo. These are request and
  UI wall times for this photo, not isolated model-kernel benchmarks.
- Visually inspected the saved selection and recoloured-preview screenshots:
  the cab door is selected and recoloured, preserving the rest of the photo.

The latest repeatable check is recorded in
[`real-ui-verification.json`](../../artifacts/sam3-runtime/real-ui-verification.json).
Selection and preview screenshots are stored in the same folder.

### Remaining limitations

- Model memory usage depends on image size and concurrent GPU activity. Only
  the tested 1200 x 800 working image is verified; 2048-pixel limits are input
  validation limits, not a promise that every image fits this GPU.
- Initial JIT compilation can take longer than warmed inference. The existing
  client has a 45-second timeout; warm the server before a first interactive
  use if needed.
- A point may select an object part rather than the entire object. Review the
  blue area and refine boundaries with Brush/Eraser. The HTTP text path exists
  but was not part of this point-only smoke test.
- Physical Android USB forwarding needs a connected, authorized phone and a
  separate device check. The browser integration and Capacitor origins in the
  existing server tests passed; this is not a physical Android verification.
  `adb devices -l` reported no attached devices during this verification.

The server remains bound to localhost. No public listener, unofficial
checkpoint, UI redesign, firmware change or unrelated CHROMA change was made.

### Additive ZeroGPU provider — 7 October 2026

The cloud Gradio deployment is isolated in `deploy/huggingface-sam3`.
The local server still uses the same HTTP contract, CUDA initialization and
official model. Shared validation/inference now lives in `core.py`; the Space
has a separate initialization adapter for ZeroGPU. See
[cloud deployment and verification notes](../../docs/SAM3_ZEROGPU.md).

Real local verification after this refactor: startup 93.609 s, first HTTP
inference 11.763 s, subsequent inference 0.684 s; 1200 × 800 mask with exactly
960000 binary alpha bytes. Sampled whole-GPU peak 7376 MiB includes Windows
graphics, not model-only VRAM. Measurement file:
`artifacts/sam3-runtime/local-development-measurements.json`.
These local measurements do not establish cloud performance or acceptance.
