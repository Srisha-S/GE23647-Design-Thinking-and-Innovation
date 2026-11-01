import assert from 'node:assert/strict';
import {
  CloudSelectionError, PUBLIC_GRADIO_CLIENT_OPTIONS, requestCloudSam3Health, requestCloudSam3Mask, selectCloudSam3Surface, validateCloudSpace,
  type CloudConnector, type CloudGradioClient, type CloudSam3Request, type GradioMessage, type GradioSubmission,
} from '../src/features/visualize/cloudSam3Client.ts';
import { createSegmentationProvider, resolveSegmentationConfiguration } from '../src/features/visualize/segmentationProviders.ts';
import { ManualMaskProvider } from '../src/features/visualize/maskProvider.ts';
import { createMask } from '../src/features/visualize/mask.ts';
import { displayToImagePoint } from '../src/features/visualize/imageUtils.ts';

let checks = 0;
const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value: unknown, message: string) => { assert.ok(value, message); checks++; };
async function failure(action: () => Promise<unknown>, code: string, message: string) {
  await assert.rejects(action, error => error instanceof CloudSelectionError && error.code === code, message); checks++;
}
async function cancelled(action: Promise<unknown>, message: string) {
  await assert.rejects(action, error => error instanceof DOMException && error.name === 'AbortError', message); checks++;
}
const png = 'data:image/png;base64,iVBORw0KGgo=';
const request: CloudSam3Request = { image: png, width: 2, height: 1, points: [{ x: 1.2, y: .4, label: 1 }] };
const response = { width: 2, height: 1, model: 'sam3', score: .9, mask_base64: btoa(String.fromCharCode(0, 255)) };
const health = { ready: true, provider: 'huggingface-zerogpu', model: 'sam3', version: 'test-version', message: 'Ready' };
const sent: Array<{ endpoint: string; payload: unknown }> = [];
let cancelCount = 0;
let closeCount = 0;
function submission(messages: GradioMessage[]): GradioSubmission {
  return { async *[Symbol.asyncIterator]() { for (const message of messages) yield message; }, cancel() { cancelCount++; } };
}
function connector(messages: GradioMessage[] = [{ type: 'data', data: [response] }], healthData: unknown = health): CloudConnector {
  return async () => ({
    async predict(endpoint, payload) { sent.push({ endpoint, payload }); return { data: [healthData] }; },
    submit(endpoint, payload) { sent.push({ endpoint, payload }); return submission(messages); },
    close() { closeCount++; },
  });
}
const options = { space: 'example/chroma-sam3', connect: connector() };

equal(PUBLIC_GRADIO_CLIENT_OPTIONS, { events: ['status', 'data'], record_history: false }, 'The public SDK connection has no token and disables browser run-history storage of photo/mask JSON.');

equal(validateCloudSpace(' example/chroma-sam3 '), 'example/chroma-sam3', 'A centralized public Space identifier is accepted.');
equal(validateCloudSpace('https://example-chroma-sam3.hf.space/'), 'https://example-chroma-sam3.hf.space', 'A public HTTPS Space origin is accepted.');
for (const value of ['', 'localhost:8001', 'http://example.hf.space', 'https://user:password@example.hf.space',
  'https://example.hf.space?token=private', 'https://example.hf.space/#private', 'https://example.hf.space/segment', 'https://untrusted.example']) {
  assert.throws(() => validateCloudSpace(value), CloudSelectionError, 'Invalid deployment addresses never receive a photo.'); checks++;
}
const production = resolveSegmentationConfiguration({ VITE_CHROMA_SAM_PROVIDER: 'local-sam3', VITE_CHROMA_SAM3_URL: 'http://localhost:8001' }, false);
equal([production.defaultEngine, production.space, production.development, production.localServerUrl], ['cloud', '', false, ''], 'An APK defaults to cloud without a local server URL even if development settings are present.');
equal(resolveSegmentationConfiguration({}, true).defaultEngine, 'local', 'Existing local Auto stays the development default.');
equal(resolveSegmentationConfiguration({ VITE_CHROMA_SAM_PROVIDER: 'cloud', VITE_CHROMA_SAM_SPACE: 'example/chroma-sam3' }, true).defaultEngine,
  'cloud', 'Development can use the cloud explicitly.');
equal(resolveSegmentationConfiguration({ VITE_CHROMA_SAM_PROVIDER: 'local-sam3' }, true).defaultEngine, 'sam3', 'The real local SAM provider remains available for development.');

equal(await requestCloudSam3Health(options), health, 'Health preserves the declared provider, official model and version contract.');
equal(sent.pop(), { endpoint: '/health', payload: [] }, 'Health calls the Gradio named API with no GPU payload.');
equal(await requestCloudSam3Health({ ...options, connect: connector([], { ...health, ready: false }) }), { ...health, ready: false }, 'Health can report a cold/unavailable model without inference.');
for (const invalid of [null, {}, { ...health, ready: 'true' }, { ...health, model: 'sam2' }, { ...health, provider: 'local' }, { ...health, version: null }]) {
  await failure(() => requestCloudSam3Health({ ...options, connect: connector([], invalid) }), 'invalid_response', 'Malformed health responses are rejected.');
}
const states: unknown[] = [];
const mask = await requestCloudSam3Mask(request, { ...options, connect: connector([
  { type: 'status', stage: 'pending', queue: true, position: 2 },
  { type: 'status', stage: 'pending', queue: true, position: 0, original_msg: 'process_starts' },
  { type: 'data', data: [response] },
]), onProgress: value => states.push(value) });
equal(Array.from(mask.data), [0, 255], 'Cloud selection decodes the existing exact-size byte-mask contract.');
equal(states, [{ state: 'connecting' }, { state: 'uploading' }, { state: 'queued', position: 2 }, { state: 'selecting' }, { state: 'success' }], 'Queue status covers the cold connection through completed selection.');
equal(sent.pop(), { endpoint: '/segment', payload: { request } }, 'A named Gradio segment call sends one JSON request input, with exact working coordinates.');
const refined = { ...request, points: [{ x: 1, y: 0, label: 1 as const }, { x: 0, y: 0, label: 0 as const }], text: 'curtain' };
await requestCloudSam3Mask(refined, options);
equal(sent.pop(), { endpoint: '/segment', payload: { request: refined } }, 'Positive/negative prompts and an optional text concept survive the transport unchanged.');

for (const invalid of [{ ...request, width: 0 }, { ...request, width: 2049 }, { ...request, height: 1.5 },
  { ...request, image: 'not-an-image' }, { ...request, image: 'data:image/png;base64,%%==' },
  { ...request, image: 'data:image/png;base64,' + 'A'.repeat(11_184_816) },
  { ...request, points: [] }, { ...request, points: Array.from({ length: 33 }, () => request.points[0]) },
  { ...request, points: [{ x: 2, y: 0, label: 1 as const }] }, { ...request, points: [{ x: NaN, y: 0, label: 1 as const }] },
  { ...request, points: [{ x: 0, y: 0, label: 0 as const }] }, { ...request, points: [null] },
  { ...request, text: 'a'.repeat(121) }]) {
  const before = sent.length;
  await failure(() => requestCloudSam3Mask(invalid as CloudSam3Request, options), 'invalid_request', 'Invalid dimensions, input size, coordinates, points and concepts never queue an upload.');
  equal(sent.length, before, 'Validation failure does not submit a cloud job.');
}

for (const invalid of [{ ...response, width: 3 }, { ...response, height: 2 }, { ...response, model: 'sam2' },
  { ...response, mask_base64: 'AA==' }, { ...response, mask_base64: '%%%=' }, { ...response, score: NaN },
  { ...response, mask_base64: btoa(String.fromCharCode(128, 255)) }]) {
  await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'data', data: [invalid] }]) }), 'invalid_response', 'Wrong geometry, model, byte count or binary mask values are rejected.');
}
await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'data', data: [{ ...response, mask_base64: 'AAA=' }] }]) }), 'no_object', 'An empty mask is an actionable no-object state.');
for (const code of ['no_object', 'quota', 'unavailable', 'invalid_request'] as const) {
  const leaked = '/private/cache/path user-photo-data';
  await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'data', data: [{ error: { code, message: leaked, retryable: true } }] }]) }), code, 'Server failure envelopes are mapped to safe client messages.');
}
await assert.rejects(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'status', stage: 'error', message: 'quota exhausted /private/path' }]) }),
  error => error instanceof CloudSelectionError && error.code === 'quota' && !error.message.includes('/private'), 'Scheduler quota errors cannot leak raw server exception text.'); checks++;
await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'status', stage: 'error', message: 'GPU is currently unavailable' }]) }), 'unavailable', 'Queue errors offer a manual fallback.');
await failure(() => requestCloudSam3Mask(request, { ...options, connect: async () => { throw new TypeError('Failed to fetch'); } }), 'offline', 'Network failure is distinct from unavailable inference.');
await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([]) }), 'invalid_response', 'An ended stream with no mask cannot look successful.');
await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'data', data: [] }]) }), 'invalid_response', 'The one-output Gradio API contract is enforced.');

const hanging: CloudConnector = async () => ({
  async predict() { return new Promise(() => undefined); },
  submit() { return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => undefined) }; }, cancel() { cancelCount++; } }; },
});
await failure(() => requestCloudSam3Mask(request, { ...options, connect: () => new Promise(() => undefined), timeoutMs: 5 }), 'timeout', 'A hung Space connection is bounded without relying on transport cancellation.');
await failure(() => requestCloudSam3Health({ ...options, connect: hanging, timeoutMs: 5 }), 'timeout', 'A hung health response cannot leave an infinite spinner.');
const beforeTimeoutCancel = cancelCount;
await failure(() => requestCloudSam3Mask(request, { ...options, connect: hanging, timeoutMs: 5 }), 'timeout', 'A queued stream also has a finite deadline.');
equal(cancelCount, beforeTimeoutCancel + 1, 'Timeout cancels the queued Gradio submission exactly once.');
const abort = new AbortController();
const pending = requestCloudSam3Mask(request, { ...options, connect: hanging, signal: abort.signal });
await new Promise(resolve => setTimeout(resolve, 0));
const beforeAbortCancel = cancelCount; abort.abort();
await cancelled(pending, 'Back navigation cancels the local pending stream promptly.');
equal(cancelCount, beforeAbortCancel + 1, 'Back navigation asks Gradio to cancel the queued submission.');
const already = new AbortController(); already.abort();
const beforeCancelled = sent.length;
await cancelled(requestCloudSam3Mask(request, { ...options, signal: already.signal }), 'Already cancelled selections send no photo.');
equal(sent.length, beforeCancelled, 'Pre-cancellation creates no cloud job.');
let releaseConnection!: (client: CloudGradioClient) => void;
const delayedConnection = new Promise<CloudGradioClient>(resolve => { releaseConnection = resolve; });
const lateAbort = new AbortController();
const late = requestCloudSam3Mask(request, { ...options, connect: () => delayedConnection, signal: lateAbort.signal });
lateAbort.abort(); await cancelled(late, 'Cancellation also works while a cold Space connection is opening.');
let lateSent = false, lateClosed = false;
releaseConnection({ async predict() { return { data: [health] }; }, submit() { lateSent = true; return submission([]); }, close() { lateClosed = true; } });
await new Promise(resolve => setTimeout(resolve, 0));
equal([lateSent, lateClosed], [false, true], 'A late connection is released and never uploads after the user leaves.');

let queuedId: string | null = null;
let assignQueueId!: (id: string) => void;
const idPending = new Promise<string>(resolve => { assignQueueId = resolve; });
const cancelledIds: Array<string | null> = [];
let uploadCloseCount = 0, iteratorReturns = 0;
const uploadAbort = new AbortController();
const delayedUpload: CloudConnector = async () => ({
  async predict() { return { data: [health] }; },
  submit() { return {
    [Symbol.asyncIterator]() { return { next: () => new Promise(() => undefined), async return() { iteratorReturns++; return { done: true, value: undefined }; } }; },
    cancel() { cancelledIds.push(queuedId); },
    event_id() { return queuedId; },
    async wait_for_id() { queuedId = await idPending; return queuedId; },
  }; },
  close() { uploadCloseCount++; },
});
const uploading = requestCloudSam3Mask(request, { ...options, connect: delayedUpload, signal: uploadAbort.signal });
await new Promise(resolve => setTimeout(resolve, 0));
uploadAbort.abort(); await cancelled(uploading, 'Cancellation during upload returns immediately while the queue ID is still pending.');
equal(cancelledIds, [null], 'The first best-effort cancellation may precede the queue ID.');
const closedBeforeId = uploadCloseCount;
assignQueueId('late-job-id');
await new Promise(resolve => setTimeout(resolve, 0));
equal(cancelledIds, [null, 'late-job-id'], 'A late queue ID is cancelled after upload finishes rather than orphaning the remote job.');
ok(uploadCloseCount > closedBeforeId && iteratorReturns >= 2, 'A stream reopened by the SDK after cancellation is closed again with its iterator.');

const image = { width: 2, height: 1, data: new Uint8ClampedArray([30, 30, 30, 255, 30, 30, 30, 255]) };
const pixelsBefore = image.data.slice();
const localProvider = createSegmentationProvider('local', production);
equal(localProvider.id, 'local-region', 'Existing local Auto is exposed through the common provider boundary.');
equal(Array.from((await localProvider.select(image, { x: 0, y: 0 }, {})).data), [255, 255], 'Local colour-region selection still produces its original mask without an internet request.');
equal(createSegmentationProvider('sam3', { ...production, development: true }).id, 'local-sam3', 'The local SAM adapter remains a separate provider.');
equal(createSegmentationProvider('cloud', production).id, 'cloud-sam3', 'Production cloud is distinct from local SAM.');
const manual = new ManualMaskProvider(2, 1);
const saved = createMask(2, 1); saved.data[0] = 255; manual.applySelection(saved);
const target = { hex: '#123456' };
const savedState = { image, target, mask: manual.mask.data.slice() };
await failure(() => requestCloudSam3Mask(request, { ...options, connect: connector([{ type: 'status', stage: 'error', message: 'quota unavailable' }]) }), 'quota', 'A failed automatic request never publishes a replacement mask.');
equal([image, target, manual.mask.data], [savedState.image, savedState.target, savedState.mask], 'Cloud errors preserve the current photo, target colour and editable mask.');
manual.beginStroke(); manual.stroke({ x: 1, y: 0 }, { x: 1, y: 0 }, .8, 'brush'); manual.endStroke();
ok(manual.mask.data[1] > 0, 'The same manual editor remains usable immediately after cloud failure.');
equal(image.data, pixelsBefore, 'Automatic providers and manual mask edits leave original photo pixels untouched.');
equal(displayToImagePoint(160, 120, { left: 10, top: 20, width: 300, height: 200 }, 1200, 800), { x: 600, y: 400 }, 'Resized cloud photos use working coordinates independent of CSS scale or DPR.');

const originalDocument = globalThis.document;
let encodedWidth = 0, encodedHeight = 0;
let encodedPixels: Uint8ClampedArray | undefined;
const canvas = { width: 0, height: 0, getContext() { return {
  createImageData(width: number, height: number) { return { data: new Uint8ClampedArray(width * height * 4) }; },
  putImageData(frame: { data: Uint8ClampedArray }) { encodedPixels = frame.data.slice(); },
}; }, toDataURL() { encodedWidth = this.width; encodedHeight = this.height; return png; } };
try {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  await selectCloudSam3Surface(image, { x: 1, y: 0 }, options);
  equal([encodedWidth, encodedHeight, encodedPixels], [2, 1, image.data], 'The uploaded PNG copies exactly the already oriented, resized working pixels.');
  equal([canvas.width, canvas.height], [0, 0], 'Temporary photo encoding canvas is released immediately.');
} finally { Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument }); }
ok(closeCount > 0, 'Finished Gradio clients release their connection resources.');

console.log(`PASS: ${checks} cloud segmentation assertions (mock transport; no real inference).`);
