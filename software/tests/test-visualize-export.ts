import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { attachPngMetadata, exportPreview, type PreviewExportDependencies, type VisualizeMetadata } from '../src/features/visualize/exportPreview.ts';
import { displayToImagePoint, getExportDimensions, loadVisualizeImage, renderOriginalPixels, validateVisualizeImageFile } from '../src/features/visualize/imageUtils.ts';

let checks = 0;
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value: unknown, message: string) { assert.ok(value, message); checks++; }
async function rejects(action: () => Promise<unknown>, message: RegExp) { await assert.rejects(action, message); checks++; }

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'));
const metadata: VisualizeMetadata = {
  product: 'CHROMA', kind: 'visualize', version: 1,
  targetColor: 'Sunbeam Yellow', targetHex: '#FFD43B', targetRgb: { r: 255, g: 212, b: 59 },
  targetLab: { l: 86.42, a: 0.39, b: 76.07 }, colourSource: 'Library',
  libraryItemId: 'saved-123', libraryItemName: 'Sunbeam Yellow — été', intensity: 75, intensityUnit: 'percent',
  imageName: 'room.png', naturalWidth: 4032, naturalHeight: 3024, outputWidth: 3265, outputHeight: 2449,
  createdAt: '2026-09-30T10:00:00.000Z',
};
function chunks(bytes: Uint8Array) {
  const result: { type: string; data: Uint8Array; crc: number; checked: number }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    result.push({ type: new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)),
      data: bytes.subarray(offset + 8, offset + 8 + length), crc: view.getUint32(offset + 8 + length),
      checked: crc32(bytes.subarray(offset + 4, offset + 8 + length)) });
    offset += length + 12;
  }
  return result;
}
function readMetadata(bytes: Uint8Array) {
  const chunk = chunks(bytes).find(chunk => chunk.type === 'iTXt')!;
  return JSON.parse(new TextDecoder().decode(chunk.data.subarray(11)));
}

const enriched = attachPngMetadata(png, metadata);
equal(readMetadata(enriched), metadata, 'PNG embeds all colour/library metadata, including UTF-8 names.');
const textChunk = chunks(enriched).find(chunk => chunk.type === 'iTXt')!;
equal(textChunk.crc, textChunk.checked, 'Embedded iTXt CRC matches the independent zlib implementation.');
equal([...textChunk.data.subarray(0, 11)], [...new TextEncoder().encode('CHROMA\0\0\0\0\0')], 'PNG iTXt is uncompressed UTF-8 with valid fields.');
equal(chunks(enriched).map(chunk => chunk.type), ['IHDR', 'IDAT', 'iTXt', 'IEND'], 'Metadata is inserted before IEND without modifying image data.');
equal(chunks(enriched).find(chunk => chunk.type === 'IDAT')!.data, chunks(png).find(chunk => chunk.type === 'IDAT')!.data, 'Compressed image pixels are unchanged.');
const twice = attachPngMetadata(enriched, { ...metadata, intensity: 50 });
equal(chunks(twice).filter(chunk => chunk.type === 'iTXt').length, 1, 'Updating CHROMA metadata replaces its earlier chunk.');
equal(readMetadata(twice).intensity, 50, 'Updated metadata is retained.');
equal(chunks(png).map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND'], 'Original PNG bytes were not mutated.');
assert.throws(() => attachPngMetadata(new Uint8Array(20), metadata), /requires a PNG/); checks++;
assert.throws(() => attachPngMetadata(png.subarray(0, png.length - 2), metadata), /incomplete/); checks++;
const broken = png.slice(); new DataView(broken.buffer).setUint32(8, 0xffffffff);
assert.throws(() => attachPngMetadata(broken, metadata), /incomplete/); checks++;

const rect = { left: 10, top: 20, width: 300, height: 200 };
equal(displayToImagePoint(160, 120, rect, 1200, 800), { x: 600, y: 400 }, 'Display points map to working image coordinates.');
equal(displayToImagePoint(310, 220, rect, 1200, 800), { x: 1199, y: 799 }, 'Exact border points stay inside the image.');
equal(displayToImagePoint(9, 20, rect, 1200, 800), null, 'Outside taps are ignored.');
equal(displayToImagePoint(311, 100, rect, 1200, 800), null, 'Outside right edge is ignored.');
equal(displayToImagePoint(10.125, 20, rect, 1200, 800), { x: 0.5, y: 0 }, 'Fractional positions support smooth brush strokes.');
equal(displayToImagePoint(85, 70, { ...rect, width: 150, height: 100 }, 1200, 800), { x: 600, y: 400 }, 'Responsive resize retains image-space mapping.');
equal(displayToImagePoint(10, 20, { ...rect, width: 0 }, 1200, 800), null, 'Hidden canvas bounds are safe.');
equal(displayToImagePoint(NaN, 20, rect, 1200, 800), null, 'Invalid positions are safe.');
equal(displayToImagePoint(10, 20, rect, 0, 800), null, 'Invalid image dimensions are safe.');
equal(getExportDimensions(640, 480), { width: 640, height: 480 }, 'Small originals are not upscaled.');
equal(getExportDimensions(8000, 1000), { width: 4096, height: 512 }, 'Panoramic output respects the edge cap.');
const big = getExportDimensions(6000, 4000);
ok(big.width > 1200 && big.width <= 4096 && big.width * big.height <= 8_000_000, 'Large originals export above working resolution within memory limits.');
assert.throws(() => getExportDimensions(-1, 4), /invalid dimensions/); checks++;

const jpeg = new File([new Uint8Array([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0])], 'photo.jpg', { type: 'image/jpeg' });
const pngFile = new File([png], 'photo.png', { type: 'image/png' });
const webp = new File([new TextEncoder().encode('RIFF0000WEBP0000')], 'photo.webp', { type: 'image/webp' });
for (const file of [jpeg, pngFile, webp]) { await validateVisualizeImageFile(file); checks++; }
await validateVisualizeImageFile(new File([png], 'camera.png')); checks++;
await rejects(() => validateVisualizeImageFile(new File([], 'empty.png', { type: 'image/png' })), /empty/);
await rejects(() => validateVisualizeImageFile(new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' })), /JPEG, PNG or WEBP/);
await rejects(() => validateVisualizeImageFile(new File(['bad'], 'bad.png', { type: 'image/png' })), /not a valid/);
await rejects(() => validateVisualizeImageFile(new File([png], 'bad.jpg', { type: 'image/jpeg' })), /not a valid/);
await rejects(() => validateVisualizeImageFile(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })), /20 MB/);

const originalImage = globalThis.Image;
const originalDocument = globalThis.document;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const urls: string[] = [];
const revoked: string[] = [];
const canvases: { width: number; height: number }[] = [];
let imageWidth = 4000;
let imageHeight = 2000;
let decodeFails = false;
let contextFails = false;
let releasedImages = 0;
class FakeImage {
  naturalWidth = imageWidth;
  naturalHeight = imageHeight;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    if (!value) { releasedImages++; return; }
    queueMicrotask(() => decodeFails ? this.onerror?.() : this.onload?.());
  }
}
try {
  Object.defineProperty(globalThis, 'Image', { value: FakeImage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: {
    createElement() {
      const canvas = { width: 0, height: 0, getContext() {
        return contextFails ? null : { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; } };
      } };
      canvases.push(canvas); return canvas;
    },
  }, configurable: true, writable: true });
  URL.createObjectURL = () => { const url = `blob:photo-${urls.length}`; urls.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); };
  const first = await loadVisualizeImage(pngFile);
  equal([first.naturalWidth, first.naturalHeight, first.width, first.height], [4000, 2000, 1200, 600], 'Original dimensions are retained alongside bounded working dimensions.');
  equal(first.pixels.data.length, 1200 * 600 * 4, 'Working pixels use the bounded preview size.');
  equal([canvases[0].width, canvases[0].height], [0, 0], 'Working canvas is released after readback.');
  const natural = renderOriginalPixels(first, 2000, 1000);
  equal([natural.width, natural.height], [2000, 1000], 'Final output can render from the original above working resolution.');
  first.dispose(); first.dispose();
  equal(revoked, [first.url], 'Image disposal revokes its object URL exactly once.');
  equal(releasedImages, 1, 'Disposal releases the retained decoder source.');
  imageWidth = 640; imageHeight = 480;
  const second = await loadVisualizeImage(webp);
  equal([second.width, second.height], [640, 480], 'Replacement image uses its own natural dimensions.');
  ok(second.url !== first.url, 'Replacement owns a separate URL.');
  second.dispose();
  equal(revoked.length, 2, 'Replacement URL is independently cleaned up.');
  decodeFails = true;
  await rejects(() => loadVisualizeImage(jpeg), /could not be decoded/);
  equal(revoked.length, 3, 'Decode failure revokes the temporary URL.');
  decodeFails = false; imageWidth = 10000; imageHeight = 10000;
  await rejects(() => loadVisualizeImage(pngFile), /40 megapixels/);
  equal(revoked.length, 4, 'Oversize natural image revokes its URL.');
  imageWidth = 640; imageHeight = 480; contextFails = true;
  await rejects(() => loadVisualizeImage(pngFile), /unavailable/);
  equal(revoked.length, 5, 'Canvas failure also revokes the URL.');
  ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'All temporary canvases are released on success and failure.');
} finally {
  Object.defineProperty(globalThis, 'Image', { value: originalImage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true, writable: true });
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
}

const downloaded: { blob: Blob; name: string }[] = [];
const shared: File[][] = [];
const browser: Partial<PreviewExportDependencies> = {
  isNative: () => false, now: () => new Date('2026-09-30T10:00:00.000Z'),
  download: (blob, name) => { downloaded.push({ blob, name }); },
  canShareFiles: () => false,
  shareFiles: async files => { shared.push(files); },
};
const pngBlob = new Blob([png], { type: 'image/png' });
equal(await exportPreview(pngBlob, metadata, 'save', browser), 'PNG preview saved with its colour metadata.', 'Browser Save downloads a PNG.');
equal(downloaded[0].blob.type, 'image/png', 'Download is an image rather than a JSON-only export.');
equal(readMetadata(new Uint8Array(await downloaded[0].blob.arrayBuffer())), metadata, 'Browser saved PNG retains library/source metadata.');
ok(/^chroma-visualize-[\w-]+\.png$/.test(downloaded[0].name), 'Export uses a safe, recognisable filename.');
await exportPreview(pngBlob, metadata, 'share', browser);
equal(downloaded.length, 2, 'Unsupported file sharing downloads the preview.');
ok(downloaded[0].name !== downloaded[1].name, 'Repeated exports have unique names.');
await exportPreview(pngBlob, metadata, 'share', { ...browser, canShareFiles: () => true });
equal(shared.length, 1, 'Supported browser share receives the image file.');
equal(readMetadata(new Uint8Array(await shared[0][0].arrayBuffer())), metadata, 'Browser sharing retains embedded metadata.');
equal(downloaded.length, 2, 'Successful browser sharing does not also download.');
equal(await exportPreview(pngBlob, metadata, 'share', { ...browser, canShareFiles: () => true, shareFiles: async () => { throw new DOMException('Cancelled', 'AbortError'); } }), 'Sharing cancelled.', 'Browser share cancellation is quiet.');
equal(downloaded.length, 2, 'Cancellation does not unexpectedly download a file.');
await rejects(() => exportPreview(pngBlob, metadata, 'share', { ...browser, canShareFiles: () => true, shareFiles: async () => { throw new Error('Share failed'); } }), /Share failed/);
await exportPreview(pngBlob, metadata, 'share', { ...browser, canShareFiles: () => { throw new Error('Unsupported'); } });
equal(downloaded.length, 3, 'A canShare capability error safely falls back to download.');
for (const name of ['NotAllowedError', 'NotSupportedError', 'SecurityError']) {
  const previousDownloads = downloaded.length;
  equal(await exportPreview(pngBlob, metadata, 'share', {
    ...browser, canShareFiles: () => true, shareFiles: async () => { throw new DOMException('Sharing unavailable', name); },
  }), 'The share menu is unavailable here. Your PNG preview was downloaded.', `${name} shares fall back to download, including expired user activation.`);
  equal(downloaded.length, previousDownloads + 1, 'A restricted share downloads the rendered image once.');
}

const nativeFiles: { name: string; data: string }[] = [];
const nativeShares: string[] = [];
const deleted: string[] = [];
const native: Partial<PreviewExportDependencies> = {
  isNative: () => true,
  writeCacheFile: async (name, data) => { nativeFiles.push({ name, data }); return { uri: `file:///cache/${name}` }; },
  deleteCacheFile: async name => { deleted.push(name); },
  nativeShare: async uri => { nativeShares.push(uri); },
  download: () => { throw new Error('Native path must not download through a browser anchor'); },
};
await exportPreview(pngBlob, metadata, 'save', native);
equal(nativeFiles.length, 1, 'Native Save writes one PNG to the Capacitor cache.');
equal(readMetadata(new Uint8Array(Buffer.from(nativeFiles[0].data, 'base64'))), metadata, 'Native file binary base64 decodes to a metadata-rich PNG.');
equal(nativeShares, [`file:///cache/${nativeFiles[0].name}`], 'Native Save uses the existing file/share pattern.');
equal(deleted.length, 0, 'Current share file remains available to the receiving app.');
await exportPreview(pngBlob, metadata, 'share', native);
equal(deleted, [nativeFiles[0].name], 'A subsequent export cleans up the previous completed share file.');
equal(nativeFiles.length, 2, 'Native Share writes a fresh PNG.');
equal(await exportPreview(pngBlob, metadata, 'share', { ...native, nativeShare: async () => { throw new Error('Share canceled'); } }), 'Sharing cancelled.', 'Native cancellation is handled quietly.');
await rejects(() => exportPreview(pngBlob, metadata, 'share', { ...native, nativeShare: async () => { throw new Error('Share plugin failed'); } }), /Share plugin failed/);

let releaseFirst: () => void = () => {};
let firstStarted: () => void = () => {};
const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
const concurrentDeletes: string[] = [];
let shareCalls = 0;
const concurrent: Partial<PreviewExportDependencies> = {
  isNative: () => true,
  writeCacheFile: async name => ({ uri: name }),
  deleteCacheFile: async name => { concurrentDeletes.push(name); },
  nativeShare: async () => { if (++shareCalls === 1) { firstStarted(); await firstGate; } },
};
const pending = exportPreview(pngBlob, metadata, 'share', concurrent);
await firstReady;
await exportPreview(pngBlob, metadata, 'share', concurrent);
equal(concurrentDeletes.length, 0, 'An in-progress share sheet file is never deleted by a concurrent export.');
releaseFirst(); await pending;
await exportPreview(pngBlob, metadata, 'share', concurrent);
equal(concurrentDeletes.length, 2, 'Completed concurrent exports become eligible for cleanup.');

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
let cancelledReads = 0;
class CountedBlob extends Blob {
  override async arrayBuffer(): Promise<ArrayBuffer> { cancelledReads++; return super.arrayBuffer(); }
}
equal(await exportPreview(new CountedBlob([png]), metadata, 'save', browser, alreadyCancelled.signal), 'Sharing cancelled.', 'An already-aborted export stops quietly before reading its blob.');
equal(cancelledReads, 0, 'An already-aborted export does not allocate or process the PNG bytes.');

const blobStarted = gate(); const blobRelease = gate();
const blobCancellation = new AbortController();
class DelayedBlob extends Blob {
  override async arrayBuffer(): Promise<ArrayBuffer> { blobStarted.release(); await blobRelease.promise; return super.arrayBuffer(); }
}
const downloadsBeforeBlobAbort = downloaded.length, sharesBeforeBlobAbort = shared.length;
const cancelledBlobExport = exportPreview(new DelayedBlob([png]), metadata, 'share', { ...browser, canShareFiles: () => true }, blobCancellation.signal);
await blobStarted.promise; blobCancellation.abort(); blobRelease.release();
equal(await cancelledBlobExport, 'Sharing cancelled.', 'Abort during an awaited blob read prevents the export from continuing.');
equal(downloaded.length, downloadsBeforeBlobAbort, 'A delayed blob-read cancellation never starts a download.');
equal(shared.length, sharesBeforeBlobAbort, 'A delayed blob-read cancellation never opens browser sharing.');

const writeStarted = gate(); const writeRelease = gate();
const writeCancellation = new AbortController();
const abortedCacheDeletes: string[] = [], abortedCacheShares: string[] = [];
let abortedCacheName = '';
const abortedCacheExport = exportPreview(pngBlob, metadata, 'share', {
  isNative: () => true,
  writeCacheFile: async (name, _data, signal) => {
    abortedCacheName = name;
    equal(signal, writeCancellation.signal, 'The native cache writer receives the export cancellation signal.');
    writeStarted.release(); await writeRelease.promise; return { uri: name };
  },
  deleteCacheFile: async name => { abortedCacheDeletes.push(name); },
  nativeShare: async uri => { abortedCacheShares.push(uri); },
}, writeCancellation.signal);
await writeStarted.promise; writeCancellation.abort();
equal(abortedCacheDeletes.length, 0, 'An aborted export waits for its pending cache write to settle before deleting that file.');
writeRelease.release();
equal(await abortedCacheExport, 'Sharing cancelled.', 'Abort during cache writing is handled quietly.');
equal(abortedCacheShares.length, 0, 'A cache write finishing after cancellation cannot open the native share sheet.');
equal(abortedCacheDeletes, [abortedCacheName], 'Only the aborted export\'s generated temporary PNG is cleaned up.');

const shareImportStarted = gate(); const shareImportRelease = gate();
const shareImportCancellation = new AbortController();
let importedShareCalls = 0, importCacheName = '';
const importDeletes: string[] = [];
const abortDuringShareImport = exportPreview(pngBlob, metadata, 'save', {
  isNative: () => true,
  writeCacheFile: async name => { importCacheName = name; return { uri: name }; },
  deleteCacheFile: async name => { importDeletes.push(name); },
  // Models the default dependency's asynchronous Capacitor Share import.
  nativeShare: async (_uri, signal) => {
    equal(signal, shareImportCancellation.signal, 'The native Share dependency receives the export cancellation signal.');
    shareImportStarted.release(); await shareImportRelease.promise;
    if (signal?.aborted) throw new DOMException('Module preparation cancelled', 'AbortError');
    importedShareCalls++;
  },
}, shareImportCancellation.signal);
await shareImportStarted.promise; shareImportCancellation.abort(); shareImportRelease.release();
equal(await abortDuringShareImport, 'Sharing cancelled.', 'Abort during native Share preparation remains quiet.');
equal(importedShareCalls, 0, 'An asynchronous Share module preparation cannot open a sheet after cancellation.');
equal(importDeletes, [importCacheName], 'Cancellation during Share preparation cleans the generated cache PNG.');

const fallbackStarted = gate(); const fallbackRelease = gate();
const fallbackCancellation = new AbortController();
let abortedFallbackDownloads = 0;
const fallbackExport = exportPreview(pngBlob, metadata, 'share', {
  ...browser, canShareFiles: () => true,
  shareFiles: async (_files, signal) => {
    equal(signal, fallbackCancellation.signal, 'Browser Share receives the export cancellation signal.');
    fallbackStarted.release(); await fallbackRelease.promise;
    throw new DOMException('User activation expired', 'NotAllowedError');
  },
  download: () => { abortedFallbackDownloads++; },
}, fallbackCancellation.signal);
await fallbackStarted.promise; fallbackCancellation.abort(); fallbackRelease.release();
equal(await fallbackExport, 'Sharing cancelled.', 'An aborted restricted share does not proceed into its download fallback.');
equal(abortedFallbackDownloads, 0, 'Leaving Visualize during sharing preparation cannot trigger a later fallback download.');

const cleanupStarted = gate(); const cleanupRelease = gate();
const cleanupCancellation = new AbortController();
let cleanupWrites = 0, cleanupShares = 0, waitForCleanup = false;
const cleanupNative: Partial<PreviewExportDependencies> = {
  isNative: () => true,
  writeCacheFile: async name => { cleanupWrites++; return { uri: name }; },
  deleteCacheFile: async () => { if (waitForCleanup) { cleanupStarted.release(); await cleanupRelease.promise; } },
  nativeShare: async () => { cleanupShares++; },
};
await exportPreview(pngBlob, metadata, 'share', cleanupNative);
waitForCleanup = true;
const abortDuringOldCleanup = exportPreview(pngBlob, metadata, 'share', cleanupNative, cleanupCancellation.signal);
await cleanupStarted.promise; cleanupCancellation.abort(); cleanupRelease.release();
equal(await abortDuringOldCleanup, 'Sharing cancelled.', 'Abort during completed-cache cleanup stops before preparing a fresh native file.');
equal(cleanupWrites, 1, 'Cancelled old-cache cleanup does not start a new cache write.');
equal(cleanupShares, 1, 'Cancelled old-cache cleanup does not open another native share sheet.');

const retryCancellation = new AbortController();
const retryNames: string[] = [], retryDeleted: string[] = [];
let retryDeleteFails = true, retryShares = 0;
const cleanupRetryNative: Partial<PreviewExportDependencies> = {
  isNative: () => true,
  writeCacheFile: async name => { retryNames.push(name); if (retryNames.length === 1) retryCancellation.abort(); return { uri: name }; },
  deleteCacheFile: async name => { retryDeleted.push(name); if (retryDeleteFails) throw new Error('Cache temporarily busy'); },
  nativeShare: async () => { retryShares++; },
};
equal(await exportPreview(pngBlob, metadata, 'share', cleanupRetryNative, retryCancellation.signal), 'Sharing cancelled.', 'A failed temporary-file cleanup does not turn cancellation into a user-facing error.');
equal(retryShares, 0, 'A failed cancellation cleanup still cannot trigger sharing.');
retryDeleteFails = false;
await exportPreview(pngBlob, metadata, 'share', cleanupRetryNative);
equal(retryDeleted, [retryNames[0], retryNames[0]], 'The next export retries only the generated cancelled cache file that could not be removed.');
equal(retryShares, 1, 'A later uncancelled export continues working after cancellation cleanup failure.');

console.log(`${checks} Visualize image/export checks passed.`);
