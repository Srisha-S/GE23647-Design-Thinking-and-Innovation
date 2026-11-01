import { CHROMA_BLE, ChromaDevice } from '../device.js';
import {
  CHROMA_BLE_CONFIG, CHROMA_DEVICE_NAME, CHROMA_SERVICE_UUID,
  CHROMA_DATA_CHARACTERISTIC_UUID, CHROMA_COMMAND_CHARACTERISTIC_UUID,
  hasBleDataConfiguration,
} from '../src/config/ble.ts';

/**
 * BLE adapter contract tests; every device and characteristic is mocked.
 * Browser: await (await import('/tests/test-bluetooth.mjs')).runBluetoothTests()
 * Node: npm test (uses tsx to load the shared TypeScript configuration).
 * All patched globals are restored, including when a check fails.
 */
export async function runBluetoothTests() {
  const checks = [];
  const assert = (condition, label) => {
    if (!condition) throw new Error(`Bluetooth test failed: ${label}`);
    checks.push(label);
  };
  const task = () => new Promise(resolve => setTimeout(resolve, 0));
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  const navigatorMock = globalThis.navigator || {};
  const originalBluetooth = Object.getOwnPropertyDescriptor(navigatorMock, 'bluetooth');
  const adapters = [];
  const fixtures = [];
  // The legacy parser plumbing remains tested separately from the default,
  // connection-only firmware preparation mode.
  const adapter = (config = { ...CHROMA_BLE_CONFIG, colourProtocolEnabled: true }) => {
    const value = new ChromaDevice(config);
    const events = { status: [], reading: [], error: [], 'device-mode': [] };
    for (const type of Object.keys(events)) value.addEventListener(type, event => events[type].push(event.detail));
    adapters.push(value);
    return { value, events };
  };
  const rejects = async (promise, label) => {
    let rejected = false;
    try { await promise; } catch { rejected = true; }
    assert(rejected, label);
  };

  class TrackedTarget extends EventTarget {
    constructor() { super(); this.listeners = new Map(); }
    addEventListener(type, callback, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
      super.addEventListener(type, callback, options);
    }
    removeEventListener(type, callback, options) {
      this.listeners.get(type)?.delete(callback);
      super.removeEventListener(type, callback, options);
    }
    count(type) { return this.listeners.get(type)?.size || 0; }
  }

  function fixture(options = {}) {
    const state = { writes: [], activeWrites: 0, maxActiveWrites: 0, stops: 0, starts: 0, disconnects: 0, requestedCharacteristics: [] };
    const notify = new TrackedTarget();
    notify.properties = options.notifyProperties ?? { notify: true, indicate: false };
    notify.startNotifications = async () => {
      ++state.starts;
      if (options.immediateReading) notify.feed(options.immediateReading);
      if (options.notifyGate) await options.notifyGate.promise;
      if (options.notificationError) throw new Error('Notifications refused');
      return notify;
    };
    notify.stopNotifications = async () => { ++state.stops; return notify; };
    notify.feed = (input) => {
      const bytes = typeof input === 'string' ? encoder.encode(input) : input;
      // Offsets catch adapters accidentally decoding the whole backing buffer.
      const backing = new Uint8Array(bytes.length + 7);
      backing.set(bytes, 3);
      notify.value = new DataView(backing.buffer, 3, bytes.length);
      notify.dispatchEvent(new Event('characteristicvaluechanged'));
    };
    const write = new TrackedTarget();
    write.properties = options.writeProperties ?? { write: true, writeWithoutResponse: true };
    const record = async (method, bytes) => {
      ++state.activeWrites;
      state.maxActiveWrites = Math.max(state.maxActiveWrites, state.activeWrites);
      state.writes.push({ method, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice() });
      await task();
      --state.activeWrites;
      if (options.writeError) throw new Error('Write refused');
    };
    write.writeValueWithResponse = bytes => record('response', bytes);
    write.writeValueWithoutResponse = bytes => record('without-response', bytes);
    const service = {
      async getCharacteristic(uuid) {
        state.requestedCharacteristics.push(uuid);
        if (options.missingCharacteristic === uuid) throw new DOMException('Missing characteristic', 'NotFoundError');
        if (uuid === CHROMA_BLE.notify) return notify;
        if (uuid === CHROMA_BLE.write) return write;
        throw new Error(`Unexpected characteristic ${uuid}`);
      },
    };
    const device = new TrackedTarget();
    device.name = options.name ?? CHROMA_DEVICE_NAME;
    device.id = 'mock-chroma';
    device.gatt = {
      connected: false,
      async connect() {
        if (options.connectGate) await options.connectGate.promise;
        if (options.connectError) throw new Error('GATT connection failed');
        this.connected = true;
        return this;
      },
      async getPrimaryService(uuid) {
        state.requestedService = uuid;
        if (options.missingService) throw new DOMException('Missing service', 'NotFoundError');
        if (uuid !== CHROMA_BLE.service) throw new Error(`Unexpected service ${uuid}`);
        return service;
      },
      disconnect() {
        ++state.disconnects;
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) device.dispatchEvent(new Event('gattserverdisconnected'));
      },
    };
    const result = { state, device, notify, write, options };
    fixtures.push(result);
    return result;
  }

  let selected;
  let chooserError;
  let chooserCalled = false;
  let chooserOptions;
  const bluetooth = {
    requestDevice(options) {
      chooserCalled = true;
      chooserOptions = options;
      return chooserError ? Promise.reject(chooserError) : Promise.resolve(selected.device);
    },
  };
  const installBluetooth = value => Object.defineProperty(navigatorMock, 'bluetooth', { configurable: true, value });
  const joinedWrites = testFixture => decoder.decode(Uint8Array.from(testFixture.state.writes.flatMap(entry => Array.from(entry.bytes))));

  try {
    if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigatorMock });
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
    installBluetooth(bluetooth);
    assert(CHROMA_BLE.service === CHROMA_SERVICE_UUID && CHROMA_BLE.write === CHROMA_COMMAND_CHARACTERISTIC_UUID && CHROMA_BLE.notify === CHROMA_DATA_CHARACTERISTIC_UUID, 'Browser UUID aliases use the shared firmware configuration');
    assert(hasBleDataConfiguration(CHROMA_BLE_CONFIG), 'The permanent firmware UUID configuration is complete');

    const { value: prepared, events: preparedEvents } = adapter(CHROMA_BLE_CONFIG);
    selected = fixture();
    const preparedFixture = selected;
    assert(await prepared.connectBluetooth(), 'Default firmware preparation mode can connect without a colour protocol');
    assert(JSON.stringify(chooserOptions.filters) === JSON.stringify([{ name: CHROMA_DEVICE_NAME }]) && JSON.stringify(chooserOptions.optionalServices) === JSON.stringify([CHROMA_SERVICE_UUID]) && !chooserOptions.acceptAllDevices, 'Default chooser selects the exact CHROMA name and permits the configured service');
    assert(prepared.mode === 'bluetooth' && prepared.connected && preparedEvents.status.at(-1).connected, 'Default BLE connection exposes its physical connection status');
    assert(preparedFixture.state.requestedCharacteristics.length === 0 && preparedFixture.state.starts === 0, 'Default BLE connection defers characteristic discovery and colour notification subscriptions');
    await prepared.setMode('compare');
    await rejects(prepared.scan(), 'Default BLE scan reports that the colour protocol is not enabled');
    assert(preparedFixture.state.writes.length === 0 && prepared.connected, 'Pending colour protocol sends no scan or mode commands and preserves the connection');
    await prepared.disconnect();
    assert(!prepared.connected && !preparedFixture.device.gatt.connected && preparedFixture.device.count('gattserverdisconnected') === 0, 'Default BLE disconnect closes GATT and releases the status listener');

    selected = fixture({ name: `${CHROMA_DEVICE_NAME} Other` });
    await rejects(prepared.connectBluetooth(), 'A differently named peripheral is rejected even if a chooser returns it');
    assert(!prepared.connected && !selected.device.gatt.connected, 'A peripheral with the wrong name never becomes connected');

    selected = fixture();
    await prepared.connectBluetooth();
    selected.device.gatt.disconnect();
    await task();
    assert(!prepared.connected && preparedEvents.status.at(-1).mode === 'disconnected', 'Default BLE mode reports unexpected link loss');

    const { value: device, events } = adapter();
    const notificationGate = deferred();
    selected = fixture({ notifyGate: notificationGate });
    const connectedFixture = selected;
    const connecting = device.connectBluetooth();
    assert(chooserCalled, 'Device chooser is requested synchronously to preserve user activation');
    assert(JSON.stringify(chooserOptions?.filters) === JSON.stringify([{ name: CHROMA_DEVICE_NAME }]) && JSON.stringify(chooserOptions.optionalServices) === JSON.stringify([CHROMA_SERVICE_UUID]) && !chooserOptions.acceptAllDevices, 'Chooser filters for CHROMA by exact name with the configured optional service');
    await task();
    assert(!device.connected && connectedFixture.state.starts === 1, 'Connection is not ready until notifications are enabled');
    notificationGate.resolve();
    assert(await connecting, 'BLE connection resolves successfully');
    assert(device.mode === 'bluetooth' && device.connected && events.status.at(-1).connected, 'Ready BLE reports a physical Bluetooth connection');
    assert(connectedFixture.state.requestedService === CHROMA_BLE.service && connectedFixture.state.requestedCharacteristics.includes(CHROMA_BLE.write) && connectedFixture.state.requestedCharacteristics.includes(CHROMA_BLE.notify), 'Both required characteristics are discovered from the advertised service');

    connectedFixture.notify.feed('{"hex":"#C7');
    assert(events.reading.length === 0, 'Incomplete Bluetooth lines remain buffered');
    connectedFixture.notify.feed('6B4A"}\n{"r":1,"g":2,"b":3}\r\n');
    assert(events.reading.length === 2 && events.reading[0].hex === '#C76B4A' && events.reading[1].hex === '#010203', 'Fragmented and multiple newline-delimited notifications parse correctly');
    assert(events.reading.every(reading => reading.source === 'bluetooth' && !Number.isNaN(Date.parse(reading.timestamp))), 'Bluetooth readings preserve their source and timestamp');
    const unicode = encoder.encode('{"hex":"#A3B18A","note":"café 🌿"}\n');
    const split = unicode.findIndex(byte => byte === 0xc3) + 1;
    connectedFixture.notify.feed(unicode.slice(0, split));
    connectedFixture.notify.feed(unicode.slice(split));
    assert(events.reading.at(-1).hex === '#A3B18A' && events.error.length === 0, 'Split UTF-8 notification bytes and optional metadata do not corrupt valid readings');
    connectedFixture.notify.feed('{"mode":"image match"}\n');
    assert(events['device-mode'].at(-1).mode === 'image-match' && events.reading.length === 3, 'Mode acknowledgements do not invent colour readings');
    connectedFixture.notify.feed('bad JSON\n{"r":999,"g":0,"b":0}\n');
    assert(events.error.length === 2 && events.reading.length === 3, 'Malformed JSON and out-of-range RGB are rejected');
    connectedFixture.notify.feed('{"hex":"#D4808E","mode":"compare"}\n');
    assert(events.reading.at(-1).hex === '#D4808E' && events.reading.at(-1).deviceMode === 'compare', 'Valid readings continue after malformed notifications');

    await Promise.all([device.setMode('image match'), device.scan(), device.setMode('compare')]);
    assert(joinedWrites(connectedFixture) === '{"command":"mode","mode":"image-match"}\n{"command":"scan"}\n{"command":"mode","mode":"compare"}\n', 'Concurrent commands retain order and their chunks never interleave');
    assert(connectedFixture.state.maxActiveWrites === 1 && connectedFixture.state.writes.every(entry => entry.bytes.length <= 20), 'BLE writes are serialized in chunks no larger than 20 bytes');
    assert(connectedFixture.state.writes.every(entry => entry.method === 'response'), 'Write-with-response is preferred when the characteristic supports it');
    const staleNotify = [...connectedFixture.notify.listeners.get('characteristicvaluechanged')][0];
    const staleDisconnected = [...connectedFixture.device.listeners.get('gattserverdisconnected')][0];
    connectedFixture.notify.feed('{"hex":"');
    await device.disconnect();
    assert(!device.connected && device.mode === 'disconnected' && !connectedFixture.device.gatt.connected, 'Explicit disconnect clears physical connection state and closes GATT');
    assert(connectedFixture.state.stops > 0 && connectedFixture.notify.count('characteristicvaluechanged') === 0 && connectedFixture.device.count('gattserverdisconnected') === 0, 'Disconnect stops notifications and removes device and characteristic listeners');
    await device.startDemo();
    const readingsBeforeStale = events.reading.length;
    connectedFixture.notify.feed('{"hex":"#000000"}\n');
    staleNotify({ target: connectedFixture.notify });
    staleDisconnected(new Event('gattserverdisconnected'));
    assert(device.mode === 'demo' && events.reading.length === readingsBeforeStale, 'Stale BLE callbacks cannot change a replacement demo session');

    selected = fixture({ writeProperties: { write: false, writeWithoutResponse: true }, notifyProperties: { notify: false, indicate: true } });
    assert(await device.connectBluetooth(), 'Indications and write-without-response characteristics are supported');
    selected.notify.feed('{"hex":"#597C8B"}\n');
    assert(events.reading.at(-1).hex === '#597C8B', 'A new connection starts with an empty notification buffer');
    await device.scan();
    assert(selected.state.writes.every(entry => entry.method === 'without-response') && joinedWrites(selected) === '{"command":"scan"}\n', 'Write-without-response is selected when it is the supported write property');
    selected.device.gatt.disconnect();
    await task();
    assert(device.mode === 'disconnected' && !device.connected && selected.notify.count('characteristicvaluechanged') === 0, 'Unexpected GATT disconnection resets state and removes notification listeners');

    for (const errorName of ['NotFoundError', 'AbortError']) {
      chooserError = new DOMException('Chooser cancelled', errorName);
      const beforeErrors = events.error.length;
      assert(await device.connectBluetooth() === false && events.error.length === beforeErrors, `${errorName} chooser cancellation is quiet`);
    }
    chooserError = null;
    installBluetooth(undefined);
    await rejects(device.connectBluetooth(), 'Unsupported browsers reject with an actionable error');
    assert(!device.connected && events.error.at(-1)?.message.toLowerCase().includes('bluetooth'), 'Unsupported browser never reports a physical connection');
    installBluetooth(bluetooth);
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    await rejects(device.connectBluetooth(), 'Insecure contexts reject Bluetooth connection');
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });

    for (const options of [
      { missingService: true },
      { missingCharacteristic: CHROMA_BLE.notify },
      { missingCharacteristic: CHROMA_BLE.write },
      { notifyProperties: { notify: false, indicate: false } },
      { writeProperties: { write: false, writeWithoutResponse: false } },
      { notificationError: true },
    ]) {
      selected = fixture(options);
      const beforeErrors = events.error.length;
      await rejects(device.connectBluetooth(), `Failed BLE discovery rejects rather than behaving like chooser cancellation: ${JSON.stringify(options)}`);
      assert(events.error.length === beforeErrors + 1 && !device.connected && !selected.device.gatt.connected && selected.notify.count('characteristicvaluechanged') === 0 && selected.device.count('gattserverdisconnected') === 0, `Invalid BLE service reports an error and releases resources: ${JSON.stringify(options)}`);
    }

    selected = fixture({ immediateReading: '{"hex":"#E9C46A"}\n' });
    await device.connectBluetooth();
    assert(events.reading.at(-1).hex === '#E9C46A', 'A notification delivered immediately during subscription is retained');
    await device.disconnect();

    selected = fixture({ writeError: true });
    await device.connectBluetooth();
    const results = await Promise.allSettled([device.setMode('image-match'), device.scan()]);
    assert(results[0].status === 'rejected' && !device.connected && !selected.device.gatt.connected, 'A failed BLE write reports failure and disconnects the partially written stream');
    assert(selected.state.writes.length === 1, 'Queued commands stop after a failed chunk instead of extending a partial command');

    const pendingGatt = deferred();
    selected = fixture({ connectGate: pendingGatt });
    const cancelledFixture = selected;
    const pendingConnection = device.connectBluetooth();
    await task();
    await device.startDemo();
    pendingGatt.resolve();
    assert(await pendingConnection === false && device.mode === 'demo' && !device.connected, 'Replacing a pending GATT connection cannot later report Bluetooth connected');
    await task();
    assert(!cancelledFixture.device.gatt.connected && cancelledFixture.device.count('gattserverdisconnected') === 0, 'A cancelled GATT connection is closed when its delayed connect finishes');

    const pendingNotifications = deferred();
    selected = fixture({ notifyGate: pendingNotifications });
    const cancelledNotifications = selected;
    const pendingReady = device.connectBluetooth();
    await task();
    await device.startDemo();
    pendingNotifications.resolve();
    assert(await pendingReady === false && device.mode === 'demo' && !device.connected, 'Replacing a pending notification subscription cannot overwrite the new session');
    await task();
    assert(!cancelledNotifications.device.gatt.connected && cancelledNotifications.notify.count('characteristicvaluechanged') === 0 && cancelledNotifications.device.count('gattserverdisconnected') === 0, 'A cancelled notification subscription releases its Bluetooth resources');
    return { passed: checks.length, checks };
  } finally {
    // Release gated mocks first so a failed assertion cannot leave cleanup hanging.
    for (const item of fixtures) {
      item.options.connectGate?.resolve();
      item.options.notifyGate?.resolve();
    }
    try { await Promise.all(adapters.map(value => value.disconnect())); } finally {
      if (originalBluetooth) Object.defineProperty(navigatorMock, 'bluetooth', originalBluetooth);
      else delete navigatorMock.bluetooth;
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else delete globalThis.navigator;
      if (originalSecure) Object.defineProperty(globalThis, 'isSecureContext', originalSecure);
      else delete globalThis.isSecureContext;
    }
  }
}
