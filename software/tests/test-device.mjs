import { ChromaDevice } from '../device.js';

/**
 * Browser transport tests. Run on localhost or HTTPS:
 *   await (await import('/tests/test-device.mjs')).runDeviceTests()
 *
 * Both transports are mocked; no chooser opens and no network request is made.
 * Run while the app is idle. Browser globals are restored even on test failure.
 */
export async function runDeviceTests() {
  if (!globalThis.isSecureContext) {
    throw new Error('Run the device tests on localhost or HTTPS, where Web Serial is available to the adapter.');
  }

  const checks = [];
  const assert = (condition, label) => {
    if (!condition) throw new Error(`Device test failed: ${label}`);
    checks.push(label);
  };
  const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
  const originalSerial = Object.getOwnPropertyDescriptor(navigator, 'serial');
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const device = new ChromaDevice();
  const events = { status: [], reading: [], error: [], 'device-mode': [] };
  for (const type of Object.keys(events)) {
    device.addEventListener(type, event => events[type].push(event.detail));
  }

  class MockReader {
    constructor() { this.queue = []; this.pending = null; this.released = false; this.cancelled = false; }
    read() {
      if (this.queue.length) return Promise.resolve(this.queue.shift());
      if (this.cancelled) return Promise.resolve({ done: true });
      return new Promise(resolve => { this.pending = resolve; });
    }
    feed(text) {
      const result = { done: false, value: new TextEncoder().encode(text) };
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(result);
      } else this.queue.push(result);
    }
    async cancel() {
      this.cancelled = true;
      if (this.pending) { this.pending({ done: true }); this.pending = null; }
    }
    releaseLock() { this.released = true; }
  }

  class MockWriter {
    constructor() { this.sent = []; this.released = false; this.aborted = false; }
    async write(value) { this.sent.push(new TextDecoder().decode(value)); }
    async abort() { this.aborted = true; }
    releaseLock() { this.released = true; }
  }

  const reader = new MockReader();
  const writer = new MockWriter();
  const port = {
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
    configuration: null,
    closed: false,
    async open(configuration) { this.configuration = configuration; },
    async close() { this.closed = true; },
  };
  let cancelChooser = false;
  const serial = {
    async requestPort() {
      if (cancelChooser) throw new DOMException('User cancelled the chooser.', 'NotFoundError');
      return port;
    },
  };

  class MockSocket extends EventTarget {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      MockSocket.instances.push(this);
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(text) { this.sent.push(text); }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  }

  try {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: serial });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: MockSocket });

    assert(device.mode === 'disconnected' && !device.connected, 'Starts disconnected without a physical device');
    await device.startDemo();
    assert(device.mode === 'demo' && !device.connected, 'Demo is never reported as physically connected');
    const sample = await device.scan();
    assert(sample.source === 'demo' && /^#[\dA-F]{6}$/.test(sample.hex) && sample.name, 'Demo emits a labelled valid colour');
    assert(events.reading.length === 1 && !Number.isNaN(Date.parse(sample.timestamp)), 'Demo scan emits once with a timestamp');
    const pendingDemo = device.scan();
    const duplicateDemo = device.scan();
    await device.disconnect();
    assert((await pendingDemo) === null && (await duplicateDemo) === null, 'Disconnect cancels all callers of a pending demo scan');
    assert(events.reading.length === 1, 'Cancelled demo does not emit a reading');

    assert(await device.connectUSB(), 'Mock USB connects');
    assert(device.connected && device.mode === 'usb' && port.configuration.baudRate === 115200, 'USB is opened at 115200 baud');
    reader.feed('{"hex":"#C7');
    await nextTask();
    assert(events.reading.length === 1, 'Incomplete serial JSON stays buffered');
    reader.feed('6B4A"}\n{"r":1,"g":2,"b":3}\r\n');
    await nextTask();
    assert(events.reading.at(-2).hex === '#C76B4A' && events.reading.at(-1).hex === '#010203', 'Split and multiple serial lines parse correctly');
    assert(events.reading.at(-1).source === 'usb', 'USB readings identify their source');
    const beforeAcknowledgement = events.reading.length;
    reader.feed('{"mode":"compare"}\n');
    await nextTask();
    assert(events['device-mode'].at(-1).mode === 'compare' && events.reading.length === beforeAcknowledgement, 'Mode acknowledgement emits a mode event without a fake reading');
    reader.feed('{"hex":"d4808e","mode":"image match"}\n');
    await nextTask();
    assert(events.reading.at(-1).hex === '#D4808E' && events.reading.at(-1).deviceMode === 'image-match', 'Reading carries normalized optional hardware mode');
    const beforeInvalid = events.reading.length;
    const beforeErrors = events.error.length;
    reader.feed('{"r":999,"g":2,"b":3}\nnot json\n');
    await nextTask();
    assert(events.reading.length === beforeInvalid && events.error.length === beforeErrors + 2, 'Invalid RGB and malformed JSON are rejected');
    await device.scan();
    await device.setMode('image match');
    assert(writer.sent[0] === '{"command":"scan"}\n' && writer.sent[1] === '{"command":"mode","mode":"image-match"}\n', 'USB sends newline-delimited scan and mode commands');
    await device.disconnect();
    assert(reader.cancelled && reader.released && writer.aborted && writer.released && port.closed, 'USB disconnect cancels reads, releases locks and closes the port');
    assert(device.mode === 'disconnected' && !device.connected, 'USB disconnect clears the physical connection state');

    cancelChooser = true;
    const errorsBeforeCancel = events.error.length;
    assert(await device.connectUSB() === false && events.error.length === errorsBeforeCancel, 'Cancelling the USB chooser is quiet');

    const connecting = device.connectWifi('wss://unit.chroma.invalid:81');
    await nextTask();
    const socket = MockSocket.instances.at(-1);
    socket.open();
    assert(await connecting && device.mode === 'wifi' && device.connected, 'Mock WebSocket connection becomes ready');
    socket.receive('{"r":199,"g":107,"b":74,"mode":"scan"}');
    assert(events.reading.at(-1).hex === '#C76B4A' && events.reading.at(-1).source === 'wifi', 'WebSocket reads a complete JSON message without a newline');
    socket.receive('{"hex":"#A3B18A"}\n{"hex":"#597C8B"}\n');
    assert(events.reading.at(-2).hex === '#A3B18A' && events.reading.at(-1).hex === '#597C8B', 'WebSocket accepts multiple newline-delimited readings');
    await device.scan();
    assert(socket.sent[0] === '{"command":"scan"}\n', 'WebSocket sends a scan command');
    const errorsBeforeBinary = events.error.length;
    socket.receive(new ArrayBuffer(8));
    assert(events.error.length === errorsBeforeBinary + 1, 'Binary WebSocket data is rejected');
    await device.disconnect();
    assert(socket.readyState === 3 && !device.connected, 'WebSocket disconnect closes the socket');

    const pendingConnection = device.connectWifi('wss://unit.chroma.invalid:82');
    await nextTask();
    await device.disconnect();
    assert(await pendingConnection === false, 'Disconnect resolves a pending Wi-Fi attempt without connecting');
    for (const address of ['https://example.com', 'wss://user:pass@example.com', 'wss://example.com/#fragment', 'not-an-address']) {
      let rejected = false;
      try { await device.connectWifi(address); } catch { rejected = true; }
      assert(rejected, `Invalid endpoint is rejected: ${address}`);
    }

    const sentBeforeIdleMode = writer.sent.length;
    await device.setMode('compare');
    assert(writer.sent.length === sentBeforeIdleMode && !device.connected, 'Changing a mode while disconnected sends no hardware command');
    return { passed: checks.length, checks };
  } finally {
    try { await device.disconnect(); } finally {
      if (originalSerial) Object.defineProperty(navigator, 'serial', originalSerial);
      else delete navigator.serial;
      if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
      else delete globalThis.WebSocket;
    }
  }
}
