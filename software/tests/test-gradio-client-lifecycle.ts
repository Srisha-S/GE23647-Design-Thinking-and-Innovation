import assert from 'node:assert/strict';
import { Client } from '@gradio/client';
import {
  CloudSelectionError, PUBLIC_GRADIO_CLIENT_OPTIONS, requestCloudSam3Mask,
  type CloudGradioClient, type CloudSam3Request,
} from '../src/features/visualize/cloudSam3Client.ts';

// Exercise the installed SDK's submit/history/cancel behavior. All photos, storage,
// HTTP responses, and SSE messages are synthetic; this never calls a real Space.
let checks = 0;
function equal(actual: unknown, expected: unknown, message: string) {
  assert.deepEqual(actual, expected, message); checks++;
}
function ok(value: unknown, message: string) { assert.ok(value, message); checks++; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const request: CloudSam3Request = {
  image: 'data:image/png;base64,iVBORw0KGgo=', width: 2, height: 1,
  points: [{ x: 1, y: 0, label: 1 }],
};
const response = { width: 2, height: 1, model: 'sam3', score: .9, mask_base64: 'AP8=' };
const storage = new Map<string, string>();
const storageWrites: string[] = [];
const memoryStorage = {
  getItem(key: string) { return storage.get(key) ?? null; },
  setItem(key: string, value: string) { storage.set(key, value); storageWrites.push(value); },
  removeItem(key: string) { storage.delete(key); },
};
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(key: string, value: unknown) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

interface SdkProbeOptions { defaultHistory?: boolean; delayedJoin?: boolean; hangingCancel?: boolean }
function sdkProbe(options: SdkProbeOptions = {}) {
  const sdk = new Client('example/chroma-sam3', options.defaultHistory
    ? { events: ['status', 'data'] } : { ...PUBLIC_GRADIO_CLIENT_OPTIONS });
  sdk.config = {
    app_id: 'synthetic-chroma-sdk-test', root: 'https://example.hf.space',
    protocol: 'sse_v3', enable_queue: true, api_prefix: '/gradio_api',
    dependencies: [{ id: 0, api_name: 'segment', api_visibility: 'public', inputs: [1], outputs: [2], queue: true }],
    components: [{ id: 1, type: 'json', props: {} }, { id: 2, type: 'json', props: {} }],
  } as unknown as NonNullable<Client['config']>;
  sdk.api_info = {
    named_endpoints: { '/segment': { parameters: [{ parameter_name: 'request', parameter_has_default: false }] } },
  } as unknown as NonNullable<Client['api_info']>;
  sdk.api_map = { segment: 0 }; sdk.api_prefix = '/gradio_api';
  const joinStarted = deferred<void>();
  const queueReply = deferred<unknown[]>();
  const cancelledIds: Array<string | null> = [];
  const state = { openedAfterClose: false, returns: 0, joins: 0 };

  // File-free JSON input: preserve the SDK's own parameter mapping and payload
  // handling while replacing every operation that could perform external I/O.
  sdk.handle_blob = async (_root, data) => data;
  sdk.post_data = async (url, body) => {
    assert.equal(new URL(url).origin + new URL(url).pathname, 'https://example.hf.space/gradio_api/queue/join');
    assert.deepEqual((body as { data: unknown[] }).data, [request]);
    state.joins++; joinStarted.resolve();
    return options.delayedJoin ? queueReply.promise : [{ event_id: 'synthetic-job-id' }, 200];
  };
  sdk.fetch = async (url, init) => {
    const path = String(url);
    assert.ok(path.endsWith('/cancel') || path.endsWith('/reset'), 'Only mocked cancellation routes are allowed.');
    if (path.endsWith('/cancel')) {
      cancelledIds.push(JSON.parse(String(init?.body)).event_id);
      if (options.hangingCancel) return new Promise<Response>(() => undefined);
    }
    return new Response('{}', { status: 200 });
  };
  sdk.open_stream = async () => {
    state.openedAfterClose ||= sdk.closed;
    sdk.stream_status.open = true;
    sdk.abort_controller = new AbortController();
    if (!options.delayedJoin) {
      await sdk.event_callbacks['synthetic-job-id']({
        msg: 'process_completed', event_id: 'synthetic-job-id', success: true,
        output: { data: [response] },
      });
    }
  };
  const actualSubmit = sdk.submit;
  sdk.submit = (...args) => {
    const job = actualSubmit(...args);
    const iterator = job[Symbol.asyncIterator]();
    const actualReturn = iterator.return?.bind(iterator);
    if (actualReturn) iterator.return = value => { state.returns++; return actualReturn(value); };
    return job;
  };
  return { sdk, state, cancelledIds, joinStarted: joinStarted.promise,
    releaseJoin: () => queueReply.resolve([{ event_id: 'synthetic-job-id' }, 200]) };
}

try {
  replaceGlobal('window', {
    localStorage: memoryStorage, sessionStorage: memoryStorage,
    location: { pathname: '/visualize', search: '', hostname: 'chroma.example' }, dispatchEvent() {},
  });
  replaceGlobal('document', { visibilityState: 'hidden' });
  replaceGlobal('fetch', async () => { throw new Error('This SDK lifecycle test forbids real network requests.'); });

  // Positive control confirms that the real SDK would store both JSON payloads
  // when no privacy option is supplied; the following safe case must stop this.
  const defaultSdk = sdkProbe({ defaultHistory: true });
  const defaultEvents = [];
  for await (const message of defaultSdk.sdk.submit('/segment', { request })) defaultEvents.push(message);
  defaultSdk.sdk.close();
  assert.ok(defaultEvents.some(message => message.type === 'data'), JSON.stringify(defaultEvents)); checks++;
  const runs = JSON.parse(storage.get('gradio:run-history:v2:synthetic-chroma-sdk-test') || '[]');
  equal(runs[0]?.inputs, [request], 'The installed SDK default records the synthetic photo request in browser history.');
  equal(runs[0]?.outputs, [response], 'The installed SDK default records the synthetic mask response in browser history.');
  storage.clear(); storageWrites.length = 0;

  const safeSdk = sdkProbe();
  const mask = await requestCloudSam3Mask(request, {
    space: 'example/chroma-sam3', connect: async () => safeSdk.sdk as unknown as CloudGradioClient,
  });
  equal(Array.from(mask.data), [0, 255], 'The production wrapper decodes a completed response through the actual SDK iterator.');
  equal(storageWrites, [], 'record_history:false prevents every browser photo/mask history write.');
  equal(storage.size, 0, 'No synthetic photo or mask remains in browser storage after success.');
  ok(!('token' in safeSdk.sdk.options), 'The real SDK has no personal Hugging Face token.');
  ok(safeSdk.sdk.closed && !safeSdk.sdk.stream_status.open, 'Completed requests close the real SDK client and SSE stream.');
  ok(safeSdk.state.returns > 0, 'Completed requests release the actual SDK iterator.');

  for (const reason of ['abort', 'timeout', 'hanging-cancel'] as const) {
    const probe = sdkProbe({ delayedJoin: true, hangingCancel: reason === 'hanging-cancel' });
    const controller = new AbortController();
    const selecting = requestCloudSam3Mask(request, {
      space: 'example/chroma-sam3', signal: controller.signal,
      timeoutMs: reason === 'timeout' ? 20 : 1000,
      connect: async () => probe.sdk as unknown as CloudGradioClient,
    });
    const rejected = assert.rejects(selecting, error => reason === 'timeout'
      ? error instanceof CloudSelectionError && error.code === 'timeout'
      : error instanceof DOMException && error.name === 'AbortError');
    await probe.joinStarted;
    if (reason !== 'timeout') controller.abort();
    await rejected; checks++;
    equal(probe.cancelledIds, [null], `${reason}: local cancellation returns promptly before the real SDK receives a queue ID.`);
    probe.releaseJoin();
    await tick();
    equal(probe.cancelledIds, [null, 'synthetic-job-id'], `${reason}: the wrapper cancels the late queue ID through the real SDK.`);
    ok(probe.state.openedAfterClose, `${reason}: the test exercises the SDK's stream reopening after the initial close.`);
    ok(probe.sdk.closed && !probe.sdk.stream_status.open && probe.sdk.abort_controller?.signal.aborted,
      `${reason}: the reopened stream closes without waiting for a remote cancellation response.`);
    ok(probe.state.returns >= 2, `${reason}: initial and late-ID cleanup release the actual SDK iterator.`);
    equal(probe.state.joins, 1, `${reason}: cancellation does not submit a duplicate photo job.`);
    equal(storageWrites, [], `${reason}: canceled and timed-out requests never persist photo/mask history.`);
  }
} finally {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
console.log(`PASS: ${checks} installed Gradio SDK lifecycle assertions (in-memory HTTP/storage; no real inference).`);
