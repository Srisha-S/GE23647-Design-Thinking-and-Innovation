---
title: CHROMA SAM 3
emoji: 🎨
colorFrom: indigo
colorTo: pink
sdk: gradio
sdk_version: 6.29.1
python_version: 3.12.12
app_file: app.py
pinned: false
tags:
  - zerogpu
models:
  - facebook/sam3
---

CHROMA object selection with the official Meta SAM 3 source pinned to
`0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc` and the gated `facebook/sam3`
`sam3.pt` checkpoint. Select **ZeroGPU** hardware in Space settings; README
metadata does not configure hardware.
Never select a paid persistent GPU for this prototype.

Set the server-side **HF_TOKEN** Space secret using an account with approved
official model access, then restart. No token is required or sent by CHROMA.
Without the secret, `/health` remains available and returns `ready: false`.

Named Gradio APIs: `/health` has no inputs; `/segment` has one JSON input named
`request` containing `{image,width,height,points,text?}`. `image` is a resized,
oriented PNG/JPEG/WebP data URL. The response preserves CHROMA's JSON mask
contract: `{width,height,model,score,mask_base64}`, where decoded raw uint8 alpha
has exactly `width × height` bytes, with values 0 and 255. Failures return
`{error:{code,message,retryable}}`. Use the Gradio client/queue protocol rather
than assuming raw FastAPI routes.

The deployment script stages shared `server/sam3/core.py` as
`chroma_sam3_core.py`. The local CUDA server remains a development provider.
GPU inference uses `@spaces.GPU(duration=60,size="large")`; startup CUDA
placement uses the official ZeroGPU emulation mechanism. `torch.compile` is
disabled. Native Triton compatibility still requires a real Space test.

Photos are passed as in-memory JSON rather than Gradio file components; this
app does not write them to disk. Browser run history, analytics and flagging
are disabled. Queue/session memory may temporarily hold request/response data;
Hugging Face handles transport and infrastructure. Only the official model
checkpoint/dependency caches persist in the runtime. Do not upload credentials,
checkpoints, photos, environments or caches into the Space repository.

Public anonymous calls are subject to ZeroGPU quota and queue limits. Current
official quotas are two GPU minutes per day for anonymous callers and five
for free authenticated users; CHROMA does not bundle personal credentials.
Free personal hosting requires a verified email, an account older than 30 days,
and an available free ZeroGPU slot. No hardware upgrade or billing is automatic.

Adapter/Gradio tests with injected test predictors establish API behavior only.
They are **not** evidence of real ZeroGPU model inference or mobile acceptance.
See the repository deployment documentation for redeployment and real tests.

References: [ZeroGPU supported stack, lifecycle and quotas](https://huggingface.co/docs/hub/spaces-zerogpu),
[Space configuration](https://huggingface.co/docs/hub/spaces-config-reference),
[official SAM 3 source](https://github.com/facebookresearch/sam3/tree/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc).
