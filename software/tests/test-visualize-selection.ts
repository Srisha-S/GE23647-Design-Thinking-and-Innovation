import assert from 'node:assert/strict';
import { createMask } from '../src/features/visualize/mask.ts';
import { ManualMaskProvider } from '../src/features/visualize/maskProvider.ts';
import { selectLocalSurface } from '../src/features/visualize/surfaceSelection.ts';
import { decodeSam3MaskResponse, requestSam3Mask } from '../src/features/visualize/segmentationClient.ts';

let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); checks++; }
function ok(value: unknown, label: string) { assert.ok(value, label); checks++; }
function throws(run: () => unknown, label: string) { assert.throws(run, undefined, label); checks++; }
async function rejects(run: () => Promise<unknown>, pattern: RegExp, label: string) { await assert.rejects(run, pattern, label); checks++; }
function image(colours: number[][], width = colours.length) {
  return { width, height: colours.length / width, data: new Uint8ClampedArray(colours.flatMap(colour => colour.length === 3 ? [...colour, 255] : colour)) };
}
const grey = [130, 130, 130], dark = [0, 0, 0], orange = [220, 70, 20];

const divided = image([grey, grey, dark, grey, grey, grey, grey, dark, grey, grey], 5);
const originalPixels = divided.data.slice();
const left = await selectLocalSurface(divided, { x: .5, y: .5 });
equal(Array.from(left.data), [255, 255, 0, 0, 0, 255, 255, 0, 0, 0], 'Tap follows a connected region and cannot cross a sharp dark boundary.');
equal(divided.data, originalPixels, 'Local selection leaves every original photo byte untouched.');
const right = await selectLocalSurface(divided, { x: 4.9, y: 1.9 });
equal(Array.from(right.data), [0, 0, 0, 255, 255, 0, 0, 0, 255, 255], 'Working-pixel coordinates select the expected side at the bottom-right edge.');

const shades = image([[70, 70, 70], [90, 90, 90], [115, 115, 115], [140, 140, 140], [170, 170, 170], [200, 200, 200]]);
const shading = await selectLocalSurface(shades, { x: 2, y: 0 });
equal(shading.data.every(value => value === 255), true, 'Smooth brightness changes remain in the selected surface instead of selecting only exact RGB.');
const chromatic = image([[90, 33, 20], [120, 44, 27], [150, 55, 35], [180, 65, 40], [210, 77, 48], [20, 80, 190]]);
const colourRegion = await selectLocalSurface(chromatic, { x: 2, y: 0 }, { tolerance: 40 });
equal(Array.from(colourRegion.data), [255, 255, 255, 255, 255, 0], 'Tolerance includes shaded warm pixels but stops at a different colour.');
const restricted = await selectLocalSurface(chromatic, { x: 2, y: 0 }, { tolerance: 1 });
ok(restricted.data.filter(Boolean).length < colourRegion.data.filter(Boolean).length, 'Tolerance actually changes selected coverage.');
const corners = image([grey, orange, orange, grey], 2);
equal(Array.from((await selectLocalSurface(corners, { x: 0, y: 0 })).data), [255, 0, 0, 0], 'Diagonal-only colour similarity is disconnected and not silently joined.');
const noWrap = image([orange, grey, grey, orange], 2);
equal(Array.from((await selectLocalSurface(noWrap, { x: 1, y: 0 })).data), [0, 255, 0, 0], 'The region queue cannot wrap at row boundaries.');
const transparent = image([[130, 130, 130, 255], [130, 130, 130, 0], [130, 130, 130, 255]]);
equal(Array.from((await selectLocalSurface(transparent, { x: 0, y: 0 })).data), [255, 0, 0], 'Transparent pixels form a boundary rather than exposing hidden RGB.');
await rejects(() => selectLocalSurface(transparent, { x: 1, y: 0 }), /visible/, 'An invisible seed produces an actionable no-selection error.');
for (const point of [{ x: -1, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 2 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
  await rejects(() => selectLocalSurface(divided, point), /within/, 'Out-of-image and non-finite seed coordinates are rejected.');
}
for (const tolerance of [0, NaN, Infinity, 81]) {
  await rejects(() => selectLocalSurface(divided, { x: 0, y: 0 }, { tolerance }), /tolerance/, 'Invalid tolerance cannot reach the colour conversion helper.');
}
await rejects(() => selectLocalSurface(divided, { x: 0, y: 0 }, { edgeThreshold: NaN }), /threshold/, 'A non-finite edge threshold is rejected before region traversal.');
await rejects(() => selectLocalSurface({ ...divided, data: new Uint8ClampedArray(3) }, { x: 0, y: 0 }), /RGBA/, 'Truncated working pixels cannot produce a partial result.');
await rejects(() => selectLocalSurface({ ...divided, width: 0 }, { x: 0, y: 0 }), /dimensions/, 'Invalid image dimensions are rejected before allocation.');
const stopped = new AbortController(); stopped.abort();
await rejects(() => selectLocalSurface(divided, { x: 0, y: 0 }, { signal: stopped.signal }), /cancelled/, 'Already-cancelled local selection does no work.');
const during = new AbortController();
const large = image(Array.from({ length: 20_000 }, () => grey), 200);
const activeSelection = selectLocalSurface(large, { x: 0, y: 0 }, { signal: during.signal });
during.abort();
await rejects(() => activeSelection, /cancelled/, 'A running local selection yields so it can be cancelled before publication.');

const provider = new ManualMaskProvider(5, 2);
equal(provider.applySelection(left), true, 'Automatic Replace commits one selection.');
equal(provider.canUndo, true, 'Automatic Replace supports the same undo flow as Brush.');
equal(provider.applySelection(right, 'add'), true, 'Automatic Add combines separated selected surfaces.');
equal(Array.from(provider.mask.data), [255, 255, 0, 255, 255, 255, 255, 0, 255, 255], 'Add preserves prior alpha coverage.');
provider.undo(); equal(provider.mask, left, 'Undo Add restores the exact previous manual/automatic mask.');
equal(provider.applySelection(left, 'remove'), true, 'Automatic Remove is supported.');
equal(provider.mask.data.some(Boolean), false, 'Remove erases only the matching region.');
provider.undo(); equal(provider.mask, left, 'Undo Remove restores every alpha byte.');
const snapshot = provider.mask.data.slice();
throws(() => provider.applySelection(createMask(2, 2)), 'Selection dimension mismatch is rejected.');
equal(provider.mask.data, snapshot, 'Invalid replacement cannot change current selection.');
equal(provider.applySelection(left), false, 'Identical automatic selection does not consume undo history.');
left.data[0] = 0;
equal(provider.mask.data[0], 255, 'Applying selection retains an independent alpha snapshot.');
const partial = createMask(5, 2); partial.data[0] = 128;
provider.applySelection(partial, 'remove');
equal(provider.mask.data[0], 127, 'Remove respects soft alpha without cutting away unrelated coverage.');
provider.undo(); provider.undo();
equal(provider.mask.data.some(Boolean), false, 'Only changed automatic operations are remembered.');

// Provenance must travel with mask bytes, including the native export's Undo path.
const sam = createMask(5, 1); sam.data[0] = 255;
const local = createMask(5, 1); local.data[3] = 255;
const provenance = new ManualMaskProvider(5, 1);
const samSource = { selectionMethod: 'sam3', selectionRefined: false };
equal(provenance.applySelection(sam, 'replace', 'sam3'), true, 'A real SAM mask records its selection source.');
equal(provenance.provenance, samSource, 'SAM Replace starts unrefined.');
ok(Object.isFrozen(provenance.provenance), 'Exposed provenance cannot mutate undo snapshots.');
provenance.stroke({ x: 2.5, y: .5 }, { x: 2.5, y: .5 }, .4, 'brush');
equal(provenance.endStroke(), true, 'Brush refinement changes the SAM mask.');
equal(provenance.provenance, { ...samSource, selectionRefined: true }, 'Brush retains SAM as its base source and records refinement.');
equal(provenance.undo(), true, 'Brush refinement can be undone.');
equal(provenance.mask, sam, 'Brush Undo restores every SAM alpha byte.');
equal(provenance.provenance, samSource, 'Brush Undo restores SAM and its unrefined state.');
provenance.applySelection(local, 'replace', 'local-region');
equal(provenance.provenance, { selectionMethod: 'local-region', selectionRefined: false }, 'On-device Replace records its own unrefined source.');
provenance.undo();
equal(provenance.mask, sam, 'Local Replace Undo restores exact SAM pixels.');
equal(provenance.provenance, samSource, 'Local Replace Undo restores the original SAM source.');
provenance.clear();
equal(provenance.provenance, { selectionMethod: 'manual', selectionRefined: false }, 'Clear starts an empty manual selection.');
provenance.undo();
equal(provenance.mask, sam, 'Clear Undo restores the original SAM mask.');
equal(provenance.provenance, samSource, 'Clear Undo restores original SAM provenance.');
provenance.applySelection(local, 'add', 'local-region');
equal(provenance.provenance, { selectionMethod: 'local-region', selectionRefined: true }, 'Changed Add retains the latest automatic method and existing refinement semantics.');
provenance.undo();
equal(provenance.provenance, samSource, 'Cross-provider Add Undo restores SAM provenance.');
provenance.applySelection(sam, 'remove', 'local-region');
equal(provenance.mask.data.some(Boolean), false, 'Automatic Remove can empty the original SAM mask.');
provenance.undo();
equal(provenance.mask, sam, 'Automatic Remove Undo restores exact SAM bytes.');
equal(provenance.provenance, samSource, 'Automatic Remove Undo restores SAM provenance.');

provenance.stroke({ x: .5, y: .5 }, { x: .5, y: .5 }, .4, 'brush');
equal(provenance.endStroke(), false, 'Painting the existing opaque pixel is a no-op.');
equal(provenance.provenance, samSource, 'No-op Brush does not falsely label SAM as refined.');
provenance.stroke({ x: 2.5, y: .5 }, { x: 2.5, y: .5 }, .5, 'brush');
provenance.stroke({ x: 2.5, y: .5 }, { x: 2.5, y: .5 }, .5, 'eraser');
equal(provenance.endStroke(), false, 'A net-zero stroke creates no undo step.');
equal(provenance.provenance, samSource, 'A net-zero stroke preserves the exact SAM provenance.');
provenance.stroke({ x: 2.5, y: .5 }, { x: 2.5, y: .5 }, .4, 'brush');
provenance.cancelStroke();
equal(provenance.mask, sam, 'Cancelled Brush restores SAM bytes.');
equal(provenance.provenance, samSource, 'Cancelled Brush restores original source and refinement.');
equal(provenance.applySelection(sam, 'replace', 'local-region'), false, 'An identical on-device result changes neither mask nor history.');
equal(provenance.provenance, samSource, 'An identical automatic result cannot overwrite SAM provenance.');
throws(() => provenance.applySelection(local, 'replace', 'invalid' as never), 'Invalid source is rejected before changing the mask.');
equal(provenance.provenance, samSource, 'Invalid automatic input preserves source and refinement.');
provenance.undo();
equal(provenance.mask.data.some(Boolean), false, 'All no-op/cancelled operations consumed no extra undo slots.');
equal(provenance.provenance, { selectionMethod: 'manual', selectionRefined: false }, 'Undoing the original SAM selection restores initial manual provenance.');
equal(provenance.canUndo, false, 'No-op operations leave the original single history entry intact.');
equal(provenance.clear(), false, 'Clearing an empty selection remains a no-op.');
equal(provenance.canUndo, false, 'Empty Clear creates no metadata-only history entry.');
provenance.stroke({ x: 2.5, y: .5 }, { x: 2.5, y: .5 }, .5, 'brush');
equal(provenance.undo(), false, 'Undo with no committed history still cancels an active first stroke.');
equal(provenance.mask.data.some(Boolean), false, 'Cancelling an uncommitted first stroke restores its empty mask.');
equal(provenance.provenance, { selectionMethod: 'manual', selectionRefined: false }, 'Undo cancellation does not invent refinement without a committed stroke.');

const capped = new ManualMaskProvider(12, 1);
const snapshots = [];
for (let index = 0; index < 12; index++) {
  const selection = createMask(12, 1); selection.data[index] = 255;
  capped.applySelection(selection, 'replace', index % 2 ? 'local-region' : 'sam3');
  snapshots.push({ mask: capped.mask.data.slice(), provenance: { ...capped.provenance } });
}
for (let index = 10; index >= 3; index--) {
  equal(capped.undo(), true, 'Bounded history restores a retained automatic selection.');
  equal(capped.mask.data, snapshots[index].mask, 'History eviction keeps mask bytes paired with the correct entry.');
  equal(capped.provenance, snapshots[index].provenance, 'History eviction keeps source/refinement paired with each retained mask.');
}
equal(capped.undo(), false, 'Provenance does not bypass the eight-snapshot history cap.');

const response = { width: 2, height: 1, model: 'sam3', score: .9, mask_base64: btoa(String.fromCharCode(0, 255)) };
equal(Array.from(decodeSam3MaskResponse(response, 2, 1).data), [0, 255], 'SAM 3 byte masks decode at the exact working-photo resolution.');
for (const invalid of [null, [], {}, { ...response, width: 3 }, { ...response, height: 2 }, { ...response, model: 'local' },
  { ...response, score: NaN }, { ...response, score: null }, { ...response, score: Infinity }, { ...response, score: 2 },
  { ...response, mask_base64: '%%==' }, { ...response, mask_base64: '////' }, { ...response, mask_base64: 'AA==' },
  { ...response, mask_base64: 'AAA=' }]) {
  throws(() => decodeSam3MaskResponse(invalid, 2, 1), 'Malformed, empty, mismatched or non-SAM masks are safely rejected.');
}
const fullSize = 1200 * 1200;
const fullAlpha = Buffer.alloc(fullSize, 255).toString('base64');
equal(decodeSam3MaskResponse({ width: 1200, height: 1200, model: 'sam3', score: 1, mask_base64: fullAlpha }, 1200, 1200).data.length,
  fullSize, 'Normal full working-size masks validate without recursive-regex stack overflow.');

const png = 'data:image/png;base64,iVBORw0KGgo=';
let request: { url?: string; body?: Record<string, unknown> } = {};
const transport = (async (url: string | URL | Request, init?: RequestInit) => {
  request = { url: String(url), body: JSON.parse(String(init?.body)) };
  return new Response(JSON.stringify(response), { status: 200 });
}) as typeof fetch;
const selected = await requestSam3Mask(png, 2, 1, { x: 1.2, y: .4 }, { serverUrl: 'http://localhost:8001/', fetch: transport });
equal(selected.data, new Uint8ClampedArray([0, 255]), 'The server response is returned as a validated selection.');
equal(request.url, 'http://localhost:8001/segment', 'The explicit configured server endpoint is used.');
equal(request.body, { image: png, width: 2, height: 1, points: [{ x: 1.2, y: .4, label: 1 }] }, 'SAM point prompts use working-image coordinates, not display or original-image pixels.');
const savedSelection = provider.mask.data.slice();
for (const url of ['javascript:alert(1)', 'file:///tmp/server', 'http://user:password@localhost:8001', 'http://localhost:8001?secret=true', 'no-url']) {
  await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: url, fetch: transport }), /address|HTTP/, 'Invalid server addresses are rejected before sending a photo.');
}
await rejects(() => requestSam3Mask('data:image/jpeg;base64,AAA=', 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: transport }), /PNG/, 'The client only sends a working-size PNG with the documented contract.');
await rejects(() => requestSam3Mask(png, 2, 1, { x: 2, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: transport }), /within/, 'Server selection also rejects out-of-bounds prompt points.');
const statusTransport = (status: number) => (async () => new Response('', { status })) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: statusTransport(503) }), /not ready/, 'Unavailable SAM weights give an actionable message instead of a fake mask.');
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: statusTransport(500) }), /HTTP 500/, 'Server errors leave the editable mask untouched.');
const malformed = (async () => new Response('not JSON')) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: malformed }), /malformed JSON/, 'Malformed JSON does not crash the editing surface.');
const excessive = (async () => new Response('x'.repeat(5000))) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: excessive }), /larger/, 'Oversized response streams are rejected before decoding.');
const oversizedHeader = (async () => new Response('ok', { headers: { 'Content-Length': '999999' } })) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: oversizedHeader }), /larger/, 'An excessive declared response size is rejected before reading.');
const mismatched = (async () => new Response(JSON.stringify({ ...response, width: 3 }))) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: mismatched }), /match/, 'Mismatched server dimensions cannot be fitted silently to the photo.');
const unavailable = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: unavailable }), /reach/, 'Network failure has an actionable fallback without automatic photo uploads elsewhere.');
const neverReturns = (() => new Promise<Response>(() => undefined)) as typeof fetch;
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: neverReturns, timeoutMs: 5 }), /timed out/, 'A hung request is bounded even if transport does not honour AbortSignal.');
const abortServer = new AbortController();
const pendingServer = requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: neverReturns, signal: abortServer.signal });
abortServer.abort();
await rejects(() => pendingServer, /cancelled/, 'Route/photo changes can cancel a pending server request promptly.');
const bodyAbort = new AbortController();
const stalledBody = (async () => new Response(new ReadableStream<Uint8Array>({ start() { /* Headers succeed but the body never arrives. */ } }))) as typeof fetch;
const bodyPending = requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: stalledBody, signal: bodyAbort.signal });
setTimeout(() => bodyAbort.abort(), 5);
await rejects(() => bodyPending, /cancelled/, 'Cancellation also stops a stalled response body after headers succeed.');
await rejects(() => requestSam3Mask(png, 2, 1, { x: 0, y: 0 }, { serverUrl: 'http://localhost:8001', fetch: transport, signal: stopped.signal }), /cancelled/, 'Already cancelled server requests never upload the working photo.');
equal(provider.mask.data, savedSelection, 'Every invalid, failed and cancelled selection preserves the existing editing mask.');

console.log(`PASS: ${checks} Visualize selection assertions.`);
