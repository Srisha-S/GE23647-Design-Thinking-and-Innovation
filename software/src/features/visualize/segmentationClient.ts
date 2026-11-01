import type { ImagePixels } from './imageUtils';
import { createMask, validateDimensions, type MaskData, type Point } from './mask';
import { throwIfSelectionAborted, validateSelectionImage, validateSelectionPoint } from './surfaceSelection';

export const DEFAULT_SAM3_SERVER = 'http://127.0.0.1:8001';
export interface Sam3SelectionOptions {
  serverUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable transport for deterministic tests; real use defaults to window.fetch. */
  fetch?: typeof fetch;
}

function endpoint(serverUrl: string): string {
  let url: URL;
  try { url = new URL(serverUrl); } catch { throw new Error('Enter the HTTP or HTTPS address of your SAM 3 server.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server address without credentials, a query or a fragment.');
  }
  return `${url.href.replace(/\/+$/, '')}/segment`;
}

/** Only accept the declared SAM 3 byte-mask contract; never reinterpret an invalid result. */
export function decodeSam3MaskResponse(value: unknown, width: number, height: number): MaskData {
  validateDimensions(width, height);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The SAM 3 server returned an invalid response.');
  const response = value as Record<string, unknown>;
  if (response.width !== width || response.height !== height || response.model !== 'sam3') {
    throw new Error('The SAM 3 mask does not match this photo or the expected model.');
  }
  if (typeof response.score !== 'number' || !Number.isFinite(response.score) || response.score < 0 || response.score > 1) {
    throw new Error('The SAM 3 server returned an invalid confidence score.');
  }
  const encoded = response.mask_base64;
  const count = width * height;
  if (typeof encoded !== 'string' || encoded.length !== Math.ceil(count / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('The SAM 3 server returned an invalid alpha mask.');
  }
  let bytes: string;
  try { bytes = atob(encoded); } catch { throw new Error('The SAM 3 server returned an invalid alpha mask.'); }
  if (bytes.length !== count) throw new Error('The SAM 3 alpha mask has the wrong pixel count.');
  const mask = createMask(width, height);
  let selected = false;
  for (let index = 0; index < count; index++) {
    mask.data[index] = bytes.charCodeAt(index);
    selected ||= mask.data[index] > 0;
  }
  if (!selected) throw new Error('SAM 3 found no selected area. Tap another part of the object or refine it with Brush.');
  return mask;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new DOMException('Selection was cancelled.', 'AbortError')); };
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => {
      signal.removeEventListener('abort', aborted); reject(error);
    });
  });
}

async function boundedResponseText(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('The SAM 3 response is larger than the expected mask.');
  if (!response.body) {
    const text = await abortable(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error('The SAM 3 response is larger than the expected mask.');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) throw new Error('The SAM 3 response is larger than the expected mask.');
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

/** Request a point-prompted mask for a PNG encoded at exactly the current working dimensions. */
export async function requestSam3Mask(imagePng: string, width: number, height: number, point: Point, options: Sam3SelectionOptions): Promise<MaskData> {
  validateDimensions(width, height);
  validateSelectionPoint(point, width, height);
  throwIfSelectionAborted(options.signal);
  if (typeof imagePng !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(imagePng) || imagePng.length > 28_000_000) {
    throw new Error('SAM 3 selection requires a PNG of the current working photo.');
  }
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError('SAM 3 timeout must be 1–120000 milliseconds.');
  const url = endpoint(options.serverUrl);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await abortable((options.fetch ?? fetch)(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ image: imagePng, width, height, points: [{ x: point.x, y: point.y, label: 1 }] }),
    }), controller.signal);
    if (!response.ok) {
      if (response.status === 503) throw new Error('SAM 3 is not ready. Start the server with its model loaded, or use local selection.');
      throw new Error(`SAM 3 selection failed (HTTP ${response.status}). Your current selection is unchanged.`);
    }
    const text = await boundedResponseText(response, Math.ceil(width * height / 3) * 4 + 4096, controller.signal);
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new Error('The SAM 3 server returned malformed JSON.'); }
    throwIfSelectionAborted(controller.signal);
    return decodeSam3MaskResponse(result, width, height);
  } catch (error) {
    if (timedOut) throw new Error('SAM 3 selection timed out. Your current selection is unchanged; try local selection or retry.');
    if (options.signal?.aborted || controller.signal.aborted) throw new DOMException('Selection was cancelled.', 'AbortError');
    if (error instanceof TypeError) throw new Error('Could not reach the SAM 3 server. Check its address and connection, or use local selection.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Explicit server mode sends only the working photo; local tap/brush editing sends nothing. */
export async function selectSam3Surface(image: ImagePixels, point: Point, options: Sam3SelectionOptions): Promise<MaskData> {
  validateSelectionImage(image);
  validateSelectionPoint(point, image.width, image.height);
  throwIfSelectionAborted(options.signal);
  const png = encodeSelectionPng(image);
  throwIfSelectionAborted(options.signal);
  return requestSam3Mask(png, image.width, image.height, point, options);
}

/** Both SAM providers encode the exact oriented working pixels shown on the canvas. */
export function encodeSelectionPng(image: ImagePixels): string {
  validateSelectionImage(image);
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG encoding is unavailable in this browser.');
    const frame = context.createImageData(image.width, image.height);
    frame.data.set(image.data); context.putImageData(frame, 0, 0);
    return canvas.toDataURL('image/png');
  } finally { canvas.width = canvas.height = 0; }
}
