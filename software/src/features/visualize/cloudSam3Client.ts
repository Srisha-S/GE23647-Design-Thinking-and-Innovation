import type { ImagePixels } from './imageUtils';
import type { MaskData, Point } from './mask';
import { decodeSam3MaskResponse, encodeSelectionPng } from './segmentationClient';
import { throwIfSelectionAborted, validateSelectionImage, validateSelectionPoint } from './surfaceSelection';

export type CloudSelectionState = 'connecting' | 'uploading' | 'queued' | 'selecting' | 'success';
export interface CloudSelectionProgress { state: CloudSelectionState; position?: number }
export type CloudFailureCode = 'timeout' | 'no_object' | 'offline' | 'quota' | 'unavailable' | 'invalid_response' | 'invalid_request';
const failureMessages: Record<CloudFailureCode, string> = {
  timeout: 'Auto Select timed out. Try again or select manually.',
  no_object: 'No suitable object was found. Tap another part of the surface or select manually.',
  offline: 'You appear to be offline. Connect to the internet or select manually.',
  quota: 'Auto Select is temporarily unavailable because the free selection allowance is in use. Try later or select manually.',
  unavailable: 'Auto Select is temporarily unavailable. Try again or select manually.',
  invalid_response: 'Auto Select returned an unusable selection. Try again or select manually.',
  invalid_request: 'This photo or tap could not be selected. Try another tap or select manually.',
};
export class CloudSelectionError extends Error {
  constructor(public readonly code: CloudFailureCode, public readonly retryable = true) {
    super(failureMessages[code]); this.name = 'CloudSelectionError';
  }
}
export interface CloudSam3Request {
  image: string;
  width: number;
  height: number;
  points: Array<Point & { label: 0 | 1 }>;
  text?: string;
}
export interface CloudSam3Health {
  ready: boolean;
  provider: 'huggingface-zerogpu';
  model: 'sam3';
  version: string;
  message: string;
}
/** Small transport boundary allows tests to exercise queues without a public GPU job. */
export interface GradioMessage {
  type: string;
  data?: unknown;
  stage?: string;
  queue?: boolean;
  position?: number;
  message?: string;
  code?: string;
  original_msg?: string;
  success?: boolean;
}
export interface GradioSubmission extends AsyncIterable<GradioMessage> {
  cancel(): unknown;
  event_id?(): string | null;
  wait_for_id?(): Promise<string | null>;
}
export interface CloudGradioClient {
  predict(endpoint: string, payload: unknown[]): Promise<{ data?: unknown }>;
  submit(endpoint: string, payload: Record<string, unknown>): GradioSubmission;
  close?(): void;
}
export type CloudConnector = (space: string) => Promise<CloudGradioClient>;
export interface CloudSam3Options {
  space: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: CloudSelectionProgress) => void;
  connect?: CloudConnector;
}

/** A public Space identifier or HTTPS Space origin only; credentials never belong here. */
export function validateCloudSpace(value: string): string {
  const space = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(space)) return space;
  try {
    const url = new URL(space);
    if (url.protocol === 'https:' && /^[A-Za-z0-9-]+\.hf\.space$/.test(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && !url.port && url.pathname === '/') return url.origin;
  } catch { /* Invalid or absent deployment configuration is a safe unavailable state. */ }
  throw new CloudSelectionError('unavailable', false);
}

export const PUBLIC_GRADIO_CLIENT_OPTIONS = {
  events: ['status', 'data'] as Array<'status' | 'data'>,
  // Gradio's default run history otherwise stores JSON input photos and masks in localStorage.
  record_history: false,
};
const connectPublicSpace: CloudConnector = async space => {
  const { Client } = await import('@gradio/client');
  // Anonymous calls only. The Space's gated-model secret stays on its server.
  return await Client.connect(space, PUBLIC_GRADIO_CLIENT_OPTIONS) as unknown as CloudGradioClient;
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Selection was cancelled.', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function connectAbortably(connect: CloudConnector, space: string, signal: AbortSignal): Promise<CloudGradioClient> {
  const connecting = connect(space);
  // A cold connection may finish after navigation or timeout; it must never submit a photo.
  void connecting.then(client => { if (signal.aborted) client.close?.(); }, () => undefined).catch(() => undefined);
  return abortable(connecting, signal);
}

function classifyFailure(error: unknown): CloudSelectionError {
  if (error instanceof CloudSelectionError) return error;
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  // Inspect only to classify. Never display or log remote exception text, paths or user content.
  if (/quota|allowance|exceeded.*(?:gpu|usage)|gpu.*(?:quota|limit)|429/i.test(message)) return new CloudSelectionError('quota');
  if (/timed?\s*out|timeout/i.test(message)) return new CloudSelectionError('timeout');
  if (/no (?:suitable |selected )?(?:object|area|mask)/i.test(message)) return new CloudSelectionError('no_object');
  if (error instanceof TypeError || /network|failed to fetch|offline|connection/i.test(message)) return new CloudSelectionError('offline');
  return new CloudSelectionError('unavailable');
}

function singleOutput(data: unknown): unknown {
  if (!Array.isArray(data) || data.length !== 1) throw new CloudSelectionError('invalid_response');
  const value: unknown = data[0];
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error: unknown }).error;
    if (!error || typeof error !== 'object' || !('code' in error)) throw new CloudSelectionError('invalid_response');
    const code = String(error.code);
    const safeCode: CloudFailureCode = Object.hasOwn(failureMessages, code) ? code as CloudFailureCode : 'unavailable';
    throw new CloudSelectionError(safeCode, !('retryable' in error) || error.retryable === true);
  }
  return value;
}

async function boundedCloudRequest<T>(options: CloudSam3Options, operation: (signal: AbortSignal, registerJob: (job: GradioSubmission, closeClient: () => void) => void) => Promise<T>): Promise<T> {
  throwIfSelectionAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new RangeError('Cloud selection timeout must be 1–300000 milliseconds.');
  const controller = new AbortController();
  let timedOut = false;
  let job: GradioSubmission | undefined;
  let closeClient: (() => void) | undefined;
  let cancelledJob = false;
  const cancelJob = () => {
    if (!job || cancelledJob) return;
    cancelledJob = true;
    const currentJob = job;
    try { void Promise.resolve(currentJob.cancel()).catch(() => undefined); } catch { /* Cancellation is best effort remotely. */ }
    // The SDK's first cancel can precede the queue's assigned ID during upload.
    // Cancel again when that late ID arrives, and close any stream the SDK reopened.
    if (currentJob.wait_for_id && !currentJob.event_id?.()) {
      try {
        void currentJob.wait_for_id().then(id => {
          if (id) { try { void Promise.resolve(currentJob.cancel()).catch(() => undefined); } catch { /* Best effort after late upload. */ } }
        }).catch(() => undefined).finally(() => { try { closeClient?.(); } catch { /* Cleanup cannot affect the editor. */ } });
      } catch { /* A failed upload has no remotely queued ID to cancel. */ }
    }
  };
  const abort = () => { controller.abort(); cancelJob(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    return await operation(controller.signal, (next, close) => { job = next; closeClient = close; if (controller.signal.aborted) cancelJob(); });
  } catch (error) {
    if (timedOut) throw new CloudSelectionError('timeout');
    if (controller.signal.aborted || options.signal?.aborted) throw new DOMException('Selection was cancelled.', 'AbortError');
    cancelJob();
    throw classifyFailure(error);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
  }
}

export async function requestCloudSam3Health(options: CloudSam3Options): Promise<CloudSam3Health> {
  const space = validateCloudSpace(options.space);
  return boundedCloudRequest(options, async signal => {
    const client = await connectAbortably(options.connect ?? connectPublicSpace, space, signal);
    throwIfSelectionAborted(signal);
    try {
      const response = await abortable(client.predict('/health', []), signal);
      const value = singleOutput(response.data);
      if (!value || typeof value !== 'object') throw new CloudSelectionError('invalid_response');
      const health = value as Record<string, unknown>;
      if (typeof health.ready !== 'boolean' || health.provider !== 'huggingface-zerogpu' || health.model !== 'sam3'
        || typeof health.version !== 'string' || typeof health.message !== 'string') throw new CloudSelectionError('invalid_response');
      return health as unknown as CloudSam3Health;
    } finally { client.close?.(); }
  });
}

export function validateCloudSam3Request(request: CloudSam3Request): void {
  if (!request || typeof request !== 'object') throw new CloudSelectionError('invalid_request', false);
  if (!Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height) || request.width < 1 || request.height < 1
    || request.width > 2048 || request.height > 2048) throw new CloudSelectionError('invalid_request', false);
  const prefix = 'data:image/png;base64,';
  if (typeof request.image !== 'string' || !request.image.startsWith(prefix)) throw new CloudSelectionError('invalid_request', false);
  const encoded = request.image.slice(prefix.length);
  if (!encoded || encoded.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    || encoded.length % 4 !== 0) throw new CloudSelectionError('invalid_request', false);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > 8 * 1024 * 1024) throw new CloudSelectionError('invalid_request', false);
  if (!Array.isArray(request.points) || !request.points.length || request.points.length > 32
    || !request.points.some(point => point?.label === 1)) throw new CloudSelectionError('invalid_request', false);
  for (const point of request.points) {
    if (!point || (point.label !== 0 && point.label !== 1)) throw new CloudSelectionError('invalid_request', false);
    try { validateSelectionPoint(point, request.width, request.height); } catch { throw new CloudSelectionError('invalid_request', false); }
  }
  if (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 120)) throw new CloudSelectionError('invalid_request', false);
}

/** Gradio owns its HTTPS queue protocol; /segment is a named API, not a FastAPI URL. */
export async function requestCloudSam3Mask(request: CloudSam3Request, options: CloudSam3Options): Promise<MaskData> {
  throwIfSelectionAborted(options.signal);
  validateCloudSam3Request(request);
  const space = validateCloudSpace(options.space);
  return boundedCloudRequest(options, async (signal, registerJob) => {
    options.onProgress?.({ state: 'connecting' });
    const client = await connectAbortably(options.connect ?? connectPublicSpace, space, signal);
    throwIfSelectionAborted(signal);
    let iterator: AsyncIterator<GradioMessage> | undefined;
    const releaseClient = () => {
      try { void Promise.resolve(iterator?.return?.()).catch(() => undefined); } catch { /* Release is best effort. */ }
      client.close?.();
    };
    try {
      options.onProgress?.({ state: 'uploading' });
      throwIfSelectionAborted(signal);
      const job = client.submit('/segment', { request });
      iterator = job[Symbol.asyncIterator]();
      registerJob(job, releaseClient);
      while (true) {
        const next = await abortable(iterator.next(), signal);
        throwIfSelectionAborted(signal);
        if (next.done) throw new CloudSelectionError('invalid_response');
        const message = next.value;
        if (message.type === 'status') {
          if (message.stage === 'error' || message.success === false) throw classifyFailure(message.message || message.code || 'unavailable');
          if (message.stage === 'pending' && message.original_msg === 'process_starts') options.onProgress?.({ state: 'selecting' });
          else if (message.stage === 'pending') options.onProgress?.({ state: 'queued', position: Number.isFinite(message.position) ? message.position : undefined });
          if (message.stage === 'generating') options.onProgress?.({ state: 'selecting' });
        } else if (message.type === 'data') {
          const output = singleOutput(message.data);
          let mask: MaskData;
          try { mask = decodeSam3MaskResponse(output, request.width, request.height); }
          catch (error) {
            if (error instanceof Error && /no selected area/.test(error.message)) throw new CloudSelectionError('no_object');
            throw new CloudSelectionError('invalid_response');
          }
          if (mask.data.some(alpha => alpha !== 0 && alpha !== 255)) throw new CloudSelectionError('invalid_response');
          options.onProgress?.({ state: 'success' });
          return mask;
        }
      }
    } finally { releaseClient(); }
  });
}

export async function selectCloudSam3Surface(image: ImagePixels, point: Point, options: CloudSam3Options): Promise<MaskData> {
  validateSelectionImage(image); validateSelectionPoint(point, image.width, image.height);
  throwIfSelectionAborted(options.signal);
  return requestCloudSam3Mask({ image: encodeSelectionPng(image), width: image.width, height: image.height, points: [{ ...point, label: 1 }] }, options);
}
