import assert from 'node:assert/strict';
import type { BleDevice, BleService, RequestBleDeviceOptions, ScanResult } from '@capacitor-community/bluetooth-le';
import { ChromaDevice } from '../device.js';
import { CHROMA_BLE_CONFIG, CHROMA_SERVICE_UUID, CHROMA_DATA_CHARACTERISTIC_UUID,
  CHROMA_COMMAND_CHARACTERISTIC_UUID, hasBleDataConfiguration, type ChromaBleConfig } from '../src/config/ble';
import { NativeBleTransport, type NativeBleClient, type BleConnectionState } from '../src/services/NativeBleTransport';
import { DeviceService } from '../src/services/DeviceService';
import { parseBlePacket } from '../src/lib/bleProtocol';
import { deltaE } from '../src/lib/color';
import type { ChromaCompareMessage, ChromaReferenceMessage } from '../src/types/deviceProtocol';
import type { DeviceReading, MatchTarget } from '../src/types';
import { encodeImageMatchResultCommand, isChromaDeviceMessage } from '../src/types/deviceProtocol';

let checks = 0;
function check(condition: unknown, description: string) { assert.ok(condition, description); checks++; }
async function rejects(task: () => Promise<unknown>, pattern: RegExp) { await assert.rejects(task, pattern); checks++; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Mock state did not settle.');
}
function view(text: string) { return new DataView(new TextEncoder().encode(text).buffer); }
const scanMessage = { type: 'scan', hex: '#C76B4A', rgb: { r: 199, g: 107, b: 74 } };
const device = { name: 'CHROMA', deviceId: 'test-device' };
// Opt into the existing provisional protocol only inside these regression tests.
const configured: ChromaBleConfig = { ...CHROMA_BLE_CONFIG,
  serviceUUID: CHROMA_SERVICE_UUID,
  dataCharacteristicUUID: CHROMA_DATA_CHARACTERISTIC_UUID,
  commandCharacteristicUUID: CHROMA_COMMAND_CHARACTERISTIC_UUID,
  colourProtocolEnabled: true,
  scanDurationMs: 10,
};

class FakeClient implements NativeBleClient {
  initialized = 0;
  initOptions: unknown;
  initError: Error | null = null;
  initGate: Promise<void> | null = null;
  enabled = true;
  enableRequests = 0;
  allowEnable = true;
  enableError: Error | null = null;
  chooserOptions: RequestBleDeviceOptions | undefined;
  chooserCalls = 0;
  chooserGate: Promise<BleDevice> | null = null;
  chosen = device;
  scanCallback: ((value: ScanResult) => void) | null = null;
  scanStops = 0;
  connections: string[] = [];
  connectGate: Promise<void> | null = null;
  disconnects: string[] = [];
  onDisconnect: (() => void) | null = null;
  notify: ((value: DataView) => void) | null = null;
  notifyGate: Promise<void> | null = null;
  notifyStarts = 0;
  notifyStops = 0;
  notifyStopGate: Promise<void> | null = null;
  notifyStopError: Error | null = null;
  writes: Uint8Array[] = [];
  serviceRequests: string[] = [];
  servicesGate: Promise<void> | null = null;
  servicesError: Error | null = null;
  services: BleService[] = [{ uuid: CHROMA_SERVICE_UUID, characteristics: [{
    uuid: CHROMA_COMMAND_CHARACTERISTIC_UUID, descriptors: [], properties: {
      broadcast: false, read: false, writeWithoutResponse: false, write: true,
      notify: false, indicate: false, authenticatedSignedWrites: false,
    },
  }] }];
  reads = 0;
  characteristicCalls: Array<{ operation: string; service: string; characteristic: string }> = [];
  writeFailAt = -1;
  readValue = view(JSON.stringify(scanMessage));
  async initialize(options?: unknown) { this.initialized++; this.initOptions = options; if (this.initGate) await this.initGate; if (this.initError) throw this.initError; }
  async isEnabled() { return this.enabled; }
  async requestEnable() { this.enableRequests++; if (this.enableError) throw this.enableError; this.enabled = this.allowEnable; }
  async requestDevice(options?: RequestBleDeviceOptions) { this.chooserCalls++; this.chooserOptions = options; return this.chooserGate ? this.chooserGate : this.chosen; }
  async requestLEScan(_options: RequestBleDeviceOptions, callback: (result: ScanResult) => void) { this.scanCallback = callback; }
  async stopLEScan() { this.scanStops++; }
  async connect(id: string, callback?: (id: string) => void) {
    this.connections.push(id); this.onDisconnect = () => callback?.(id);
    if (this.connectGate) await this.connectGate;
  }
  async disconnect(id: string) { this.disconnects.push(id); }
  async getServices(id: string) {
    this.serviceRequests.push(id);
    if (this.servicesGate) await this.servicesGate;
    if (this.servicesError) throw this.servicesError;
    return this.services;
  }
  async read(_id: string, service: string, characteristic: string) {
    this.reads++; this.characteristicCalls.push({ operation: 'read', service, characteristic });
    return this.readValue;
  }
  async write(_id: string, _service: string, _characteristic: string, value: DataView) {
    this.characteristicCalls.push({ operation: 'write', service: _service, characteristic: _characteristic });
    const index = this.writes.length;
    this.writes.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (index === this.writeFailAt) throw new Error('Radio write failed');
  }
  async startNotifications(_id: string, _service: string, _characteristic: string, callback: (value: DataView) => void) {
    this.characteristicCalls.push({ operation: 'notify', service: _service, characteristic: _characteristic });
    this.notifyStarts++; this.notify = callback;
    if (this.notifyGate) await this.notifyGate;
  }
  async stopNotifications() { this.notifyStops++; if (this.notifyStopGate) await this.notifyStopGate; if (this.notifyStopError) throw this.notifyStopError; }
}
function fixture(config: ChromaBleConfig = configured) {
  const client = new FakeClient();
  const fallback = new ChromaDevice();
  const transport = new NativeBleTransport(client, fallback, config);
  const states: BleConnectionState[] = [];
  const readings: Array<{ hex: string; source: string }> = [];
  const comparisons: unknown[] = [];
  const rawData: Array<{ text: string }> = [];
  const deviceData: unknown[] = [];
  const errors: string[] = [];
  transport.addEventListener('ble-state', event => states.push((event as CustomEvent).detail));
  transport.addEventListener('reading', event => readings.push((event as CustomEvent).detail));
  transport.addEventListener('comparison', event => comparisons.push((event as CustomEvent).detail));
  transport.addEventListener('ble-data', event => rawData.push((event as CustomEvent).detail));
  transport.addEventListener('device-data', event => deviceData.push((event as CustomEvent).detail));
  transport.addEventListener('error', event => errors.push((event as CustomEvent).detail.message));
  return { client, transport, fallback, states, readings, comparisons, rawData, deviceData, errors };
}

check(hasBleDataConfiguration() && !CHROMA_BLE_CONFIG.colourProtocolEnabled, 'Shipped native configuration uses permanent UUIDs and leaves legacy JSON disabled.');
check(hasBleDataConfiguration(configured), 'A complete valid firmware configuration is recognized.');
check(!hasBleDataConfiguration({ ...configured, serviceUUID: 'placeholder' }), 'Malformed firmware UUIDs cannot enable writes.');
check(isChromaDeviceMessage(scanMessage), 'A consistent scan payload is accepted.');
check(isChromaDeviceMessage({ ...scanMessage, hsl: { h: 360, s: 0, l: 100 }, lab: { l: 50, a: -2, b: 3 }, cmyk: { c: 0, m: 0, y: 0, k: 100 }, clear: 12 }), 'Optional sensor colour fields are supported.');
check(!isChromaDeviceMessage({ ...scanMessage, rgb: { r: 300, g: 107, b: 74 } }), 'Out-of-range RGB is rejected.');
check(!isChromaDeviceMessage({ ...scanMessage, rgb: { r: 199.2, g: 107, b: 74 } }), 'Fractional RGB is rejected.');
check(!isChromaDeviceMessage({ ...scanMessage, hex: '#FFFFFF' }), 'Inconsistent RGB/HEX cannot reach the workspace.');
check(!isChromaDeviceMessage({ ...scanMessage, hsl: { h: 3, s: 101, l: 10 } }), 'Invalid optional HSL is rejected.');
check(!isChromaDeviceMessage({ ...scanMessage, lab: { l: 50, a: Infinity, b: 0 } }), 'Nonfinite LAB is rejected.');
check(!isChromaDeviceMessage({ ...scanMessage, cmyk: { c: 0, m: 0, y: 0, k: -1 } }), 'Invalid CMYK is rejected.');
check(!isChromaDeviceMessage({ ...scanMessage, clear: -1 }), 'Negative clear-channel values are rejected.');
const compareMessage = { type: 'compare', reference: scanMessage, sample: scanMessage, deltaE: 0 };
check(isChromaDeviceMessage(compareMessage), 'Compare protocol supports reference, sample and deltaE.');
check(!isChromaDeviceMessage({ ...compareMessage, deltaE: -1 }), 'Negative deltaE is rejected.');
check(!isChromaDeviceMessage({ type: 'demo', ...scanMessage, rgb: undefined }), 'Incomplete payloads are rejected.');

{
  const { client, transport, states, readings } = fixture(CHROMA_BLE_CONFIG);
  check(transport.mode === 'disconnected' && !transport.connected, 'No device connects automatically.');
  check(await transport.connectBluetooth(), 'A GATT link can connect before the colour protocol is enabled.');
  check(JSON.stringify(client.initOptions) === '{"androidNeverForLocation":true}', 'Initialization requests plugin permissions with manifest-compatible location policy.');
  check(client.chooserOptions?.name === 'CHROMA' && !client.chooserOptions.services, 'Chooser filters the exact firmware device name.');
  check(states.some(s => s.state === 'searching') && states.some(s => s.state === 'found') && states.some(s => s.state === 'connecting'), 'Discovery and connecting states reach UI.');
  check(transport.mode === 'bluetooth' && transport.connected && transport.getBleState().state === 'connected', 'Only completed GATT setup becomes connected.');
  check(transport.getBleState().configured && /Ready for Scan and Compare results/i.test(transport.getBleState().message || ''), 'Connection status advertises compact scan and compare readiness.');
  check(client.notifyStarts === 1 && readings.length === 0, 'Configured connections subscribe to raw notifications without inventing a colour reading.');
  check(await transport.scan() === null, 'Native v1 waits for a physical SCAN without sending a command.');
  await rejects(() => transport.readData(), /commands and reads are not defined yet/);
  await transport.subscribeToData();
  await rejects(() => transport.writeCommand({ command: 'scan' }), /commands and reads are not defined yet/);
  await transport.setMode('compare');
  check(client.writes.length === 0 && client.reads === 0 && client.notifyStarts === 1,
    'Protocol-disabled browsing and direct hooks cannot read or write; repeated raw subscription is idempotent.');
  await transport.disconnect();
  check(client.disconnects.includes(device.deviceId) && transport.getBleState().state === 'disconnected', 'Disconnect releases the native link and updates status.');
}
{
  const { client, transport, rawData, readings, comparisons, deviceData, errors } = fixture(CHROMA_BLE_CONFIG);
  await transport.connectBluetooth();
  client.notify?.(view('CHROMA_TEST'));
  check(rawData.length === 1 && rawData[0].text === 'CHROMA_TEST', 'An unframed CHROMA_TEST notification immediately emits raw UTF-8 text.');
  const arbitrary = '  <strong>CHROMA</strong> & arbitrary text\nsecond line\u0000  ';
  client.notify?.(view(arbitrary));
  check(rawData.at(-1)?.text === arbitrary, 'Raw notifications preserve arbitrary text, whitespace, line breaks and markup as text.');
  const text = 'CHROMA café 🎨';
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(bytes.length + 6);
  padded.fill(0x58); padded.set(bytes, 3);
  client.notify?.(new DataView(padded.buffer, 3, bytes.length));
  check(rawData.at(-1)?.text === text, 'UTF-8 decoding respects nonzero DataView offsets and byte lengths.');
  const emoji = new TextEncoder().encode('🎨');
  const beforePartial = rawData.length;
  client.notify?.(new DataView(emoji.buffer, 0, 2));
  check(rawData.length === beforePartial && rawData.at(-1)?.text === text, 'An incomplete UTF-8 code point does not emit empty text or replace the latest value.');
  client.notify?.(new DataView(emoji.buffer, 2, 2));
  check(rawData.at(-1)?.text === '🎨', 'A UTF-8 code point split between notifications is decoded without replacement characters.');
  client.notify?.(view('first'));
  client.notify?.(view('second'));
  client.notify?.(view('second'));
  check(rawData.slice(-3).map(data => data.text).join('|') === 'first|second|second', 'Each notification emits its own latest text, including repeated values.');
  const beforeEmpty = rawData.length;
  client.notify?.(new DataView(new ArrayBuffer(0)));
  check(rawData.length === beforeEmpty, 'An empty notification does not erase the latest received text.');
  client.notify?.(view(JSON.stringify(scanMessage) + '\n' + JSON.stringify(compareMessage) + '\n'));
  check(readings.length === 0 && comparisons.length === 0 && deviceData.length === 0,
    'Raw debug notifications cannot emit colour, comparison or workspace data events, even for protocol-shaped JSON.');
  check(errors.length === 0, 'Arbitrary raw data is not rejected as malformed colour JSON.');
  check(client.characteristicCalls.length === 1 && client.characteristicCalls[0].operation === 'notify' &&
    client.characteristicCalls[0].service === CHROMA_SERVICE_UUID &&
    client.characteristicCalls[0].characteristic === CHROMA_DATA_CHARACTERISTIC_UUID,
  'Raw mode subscribes only to the shared DATA UUID and never accesses COMMAND.');
  const oldNotify = client.notify;
  const beforeDisconnect = rawData.length;
  await transport.disconnect();
  check(client.notifyStops === 1 && client.disconnects.length === 1, 'Explicit raw-mode disconnect stops notifications and releases the peripheral.');
  oldNotify?.(view('STALE'));
  check(rawData.length === beforeDisconnect, 'A callback retained by the plugin cannot emit text after explicit disconnect.');
}
{
  const { client, transport, states, rawData } = fixture(CHROMA_BLE_CONFIG);
  const gate = deferred<void>(); client.notifyGate = gate.promise;
  const connecting = transport.connectBluetooth();
  await until(() => client.notifyStarts === 1);
  check(transport.getBleState().state === 'connecting' && !states.some(state => state.state === 'connected'),
    'Raw-mode connection status waits for notification subscription success.');
  gate.resolve();
  check(await connecting && transport.getBleState().state === 'connected', 'Successful raw subscription completes connection status.');
  await Promise.all([transport.subscribeToData(), transport.subscribeToData()]);
  check(client.notifyStarts === 1, 'Repeated raw-mode subscription requests keep exactly one listener.');
  client.notify?.(view('READY'));
  check(rawData.at(-1)?.text === 'READY', 'A ready raw session accepts data without a newline terminator.');
  await transport.disconnect();
}
{
  const { client, transport, rawData, states } = fixture(CHROMA_BLE_CONFIG);
  const gate = deferred<void>(); client.notifyGate = gate.promise;
  const result = transport.connectBluetooth();
  const rejected = rejects(() => result, /Cannot subscribe to DATA notifications/);
  await until(() => client.notifyStarts === 1);
  const failedNotify = client.notify;
  gate.reject(new Error('Cannot subscribe to DATA notifications'));
  await rejected;
  check(!transport.connected && transport.getBleState().state === 'error' && !states.some(state => state.state === 'connected'),
    'Failed subscription never reports a completed raw-mode connection.');
  check(client.notifyStops >= 1 && client.disconnects.length === 1, 'Subscription failure attempts listener cleanup and disconnects the peripheral.');
  failedNotify?.(view('STALE_FAILURE'));
  check(rawData.length === 0, 'Failed-subscription callbacks cannot deliver stale debug text.');
  client.notifyGate = null;
  check(await transport.connectBluetooth(), 'A notification setup failure does not prevent a later reconnect.');
  await transport.disconnect();
}
{
  const { client, transport, rawData } = fixture(CHROMA_BLE_CONFIG);
  await transport.connectBluetooth();
  const bytes = new TextEncoder().encode('🎨');
  client.notify?.(new DataView(bytes.buffer, 0, 2));
  const staleNotify = client.notify;
  const staleDisconnect = client.onDisconnect;
  client.onDisconnect?.();
  check(!transport.connected && transport.getBleState().state === 'disconnected', 'Link loss immediately clears raw-mode connection state.');
  await until(() => client.notifyStops === 1 && client.disconnects.length === 1);
  staleNotify?.(view('STALE_LINK_LOSS'));
  check(rawData.length === 0, 'Link loss invalidates notification callbacks before asynchronous cleanup completes.');
  await transport.connectBluetooth();
  client.notify?.(view('FRESH'));
  check(rawData.at(-1)?.text === 'FRESH', 'Reconnect uses a fresh UTF-8 decoder rather than carrying an incomplete previous code point.');
  staleNotify?.(view('OLD_SESSION'));
  staleDisconnect?.();
  check(rawData.at(-1)?.text === 'FRESH' && transport.connected, 'Old notification and link-loss callbacks cannot mutate a newer connection.');
  await transport.disconnect();
}
{
  const { client, transport, rawData } = fixture(CHROMA_BLE_CONFIG);
  const gate = deferred<void>(); client.notifyGate = gate.promise;
  const pending = transport.connectBluetooth();
  await until(() => client.notifyStarts === 1);
  const pendingNotify = client.notify;
  await transport.disconnect();
  check(await pending === false, 'Cancelling a pending notification subscription resolves connection cancellation promptly.');
  pendingNotify?.(view('CANCELLED'));
  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 1));
  check(rawData.length === 0 && !transport.connected && client.notifyStops >= 1,
    'Late subscription completion after cancellation cannot revive notifications or connection status.');
}
{
  const { client, transport, rawData } = fixture(CHROMA_BLE_CONFIG);
  await transport.connectBluetooth();
  const staleNotify = client.notify;
  client.notifyStopError = new Error('Already disconnected');
  await transport.disconnect();
  staleNotify?.(view('STALE_STOP_FAILURE'));
  check(client.notifyStops === 1 && client.disconnects.length === 1 && !transport.connected && rawData.length === 0,
    'A plugin stop-notifications rejection still invalidates callbacks and disconnects cleanly.');
  client.notifyStopError = null;
  await transport.connectBluetooth();
  client.notify?.(view('RECONNECTED'));
  check(rawData.at(-1)?.text === 'RECONNECTED', 'A stop-notifications failure does not poison the next raw session.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture({ ...configured, serviceUUID: 'invalid-test-uuid' });
  check(await transport.connectBluetooth() && !transport.getBleState().configured,
    'Invalid UUID configuration still permits a connection-only session.');
  await rejects(() => transport.subscribeToData(), /UUIDs.*src\/config\/ble.ts/);
  await rejects(() => transport.scan(), /UUIDs.*src\/config\/ble.ts/);
  await transport.setMode('compare');
  check(client.characteristicCalls.length === 0, 'The protocol flag cannot bypass UUID validation for notifications or commands.');
  await transport.disconnect();
}
{
  const { client, transport, readings, comparisons, errors } = fixture();
  const notifyGate = deferred<void>(); client.notifyGate = notifyGate.promise;
  const connecting = transport.connectBluetooth();
  await until(() => client.notifyStarts === 1);
  check(transport.getBleState().state === 'connecting', 'Connection UI waits until notifications are ready.');
  notifyGate.resolve(); await connecting;
  check(client.notifyStarts === 1 && transport.getBleState().configured, 'Configured connections subscribe once.');
  await transport.subscribeToData();
  check(client.notifyStarts === 1, 'Repeated subscription calls do not install duplicate callbacks.');
  const bytes = new TextEncoder().encode(JSON.stringify({ ...scanMessage, note: 'café' }) + '\n');
  const split = bytes.indexOf(0xC3) + 1;
  client.notify?.(new DataView(bytes.buffer, 0, split));
  check(readings.length === 0, 'Fragmented notification does not produce an incomplete colour.');
  client.notify?.(new DataView(bytes.buffer, split));
  check(readings.length === 1 && readings[0].hex === '#C76B4A' && readings[0].source === 'bluetooth', 'Split UTF-8 and offset views produce a real Bluetooth reading.');
  client.notify?.(view(JSON.stringify(compareMessage) + '\nnot-json\n' + JSON.stringify(scanMessage) + '\n'));
  check(comparisons.length === 1 && readings.length === 2, 'Compare results stay separate from scan readings across multiple framed messages.');
  check(errors.length === 1, 'Malformed notification is reported without losing the next valid message.');
  const read = await transport.readData();
  check(read.type === 'scan' && read.hex === scanMessage.hex, 'Read API validates a real characteristic payload.');
  client.readValue = view('{"type":"scan","hex":"#C76B4A"}');
  await rejects(() => transport.readData(), /invalid colour/);
  await Promise.all([transport.setMode('image-match'), transport.scan()]);
  check(client.writes.every(chunk => chunk.length <= 20), 'Commands use conservative 20-byte BLE chunks.');
  const commands = new TextDecoder().decode(Uint8Array.from(client.writes.flatMap(value => [...value])));
  check(commands === '{"command":"mode","mode":"image-match"}\n{"command":"scan"}\n', 'Concurrent commands stay complete and ordered, with newline framing.');
  check(client.characteristicCalls.every(call => call.service === CHROMA_SERVICE_UUID &&
    call.characteristic === (call.operation === 'write' ? CHROMA_COMMAND_CHARACTERISTIC_UUID : CHROMA_DATA_CHARACTERISTIC_UUID)),
  'Future data hooks use the permanent service, DATA and COMMAND constants consistently.');
  const staleNotify = client.notify;
  const staleDisconnect = client.onDisconnect;
  await transport.disconnect();
  check(client.notifyStops === 1 && !transport.connected, 'Disconnect unsubscribes and clears hardware state.');
  staleNotify?.(view(JSON.stringify(scanMessage) + '\n'));
  check(readings.length === 2, 'Stale notifications after disconnect cannot add a reading.');
  await transport.startDemo();
  staleDisconnect?.();
  check(transport.mode === 'demo' && !transport.connected, 'An old link-loss callback cannot disconnect demo mode.');
  await transport.disconnect();
}
{
  const { client, transport, readings } = fixture();
  await transport.connectBluetooth();
  client.notify?.(view('{"type":"scan",'));
  client.onDisconnect?.();
  check(!transport.connected && transport.getBleState().state === 'disconnected', 'Unexpected link loss releases physical connection state.');
  await transport.connectBluetooth();
  client.notify?.(view(JSON.stringify(scanMessage) + '\n'));
  check(readings.length === 1, 'A reconnect discards the previous partial JSON buffer.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture();
  client.initError = new Error('Permission denied');
  await rejects(() => transport.connectBluetooth(), /Nearby devices/);
  check(transport.getBleState().state === 'permission-denied' && client.chooserCalls === 0, 'Permission failure gets a recovery state before discovery.');
  client.initError = new Error('BLE unsupported');
  await rejects(() => transport.connectBluetooth(), /unsupported/);
  check(transport.getBleState().state === 'unavailable', 'Hardware without BLE reports unavailable.');
  client.initError = null; client.enabled = false;
  await transport.connectBluetooth();
  check(client.enableRequests === 1 && transport.connected, 'Bluetooth-off state uses the Android enable prompt.');
  await transport.disconnect();
  client.enabled = false; client.allowEnable = false;
  await rejects(() => transport.connectBluetooth(), /switched off/);
  check(transport.getBleState().state === 'unavailable', 'Declining Bluetooth enable leaves an actionable unavailable state.');
  client.enableError = new Error('User cancelled enable request');
  await rejects(() => transport.connectBluetooth(), /switched off/);
  check(transport.getBleState().state === 'unavailable', 'Cancelling the system enable dialog is not confused with cancelling device selection.');
}
{
  const { client, transport } = fixture();
  const chooser = deferred<BleDevice>(); client.chooserGate = chooser.promise;
  const attempt = transport.connectBluetooth();
  await until(() => client.chooserCalls === 1);
  await transport.disconnect();
  check(await attempt === false, 'Cancelling pending chooser settles the UI immediately.');
  chooser.resolve(device);
  await new Promise(resolve => setTimeout(resolve, 1));
  check(client.connections.length === 0, 'A chooser result arriving after cancellation never connects.');
  client.chooserGate = Promise.reject(new Error('Request canceled by user'));
  check(await transport.connectBluetooth() === false && transport.getBleState().state === 'disconnected', 'Native chooser cancellation is quiet and disconnected.');
}
{
  const { client, transport } = fixture();
  const init = deferred<void>(); client.initGate = init.promise;
  const old = transport.connectBluetooth();
  await until(() => client.initialized === 1);
  await transport.startDemo();
  init.resolve();
  check(await old === false && transport.mode === 'demo', 'Cancelled initialization cannot replace the newly selected demo transport.');
  check(client.chooserCalls === 0, 'No delayed permission completion can open a stale chooser.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture();
  const connect = deferred<void>(); client.connectGate = connect.promise;
  const old = transport.connectBluetooth();
  await until(() => client.connections.length === 1);
  await transport.disconnect();
  check(await old === false, 'Cancelling an in-flight GATT attempt resolves false.');
  connect.resolve();
  await new Promise(resolve => setTimeout(resolve, 1));
  check(!transport.connected && client.notifyStarts === 0 && client.disconnects.length >= 1, 'Late GATT success is cleaned up without subscribing.');
}
{
  const { client, transport, fallback } = fixture();
  const cleanup = deferred<void>();
  let cleanups = 0;
  const originalDisconnect = fallback.disconnect.bind(fallback);
  fallback.disconnect = async () => { await originalDisconnect(); if (++cleanups === 1) await cleanup.promise; };
  const old = transport.connectBluetooth();
  const newer = transport.startDemo();
  await newer;
  cleanup.resolve();
  check(await old === false && client.chooserCalls === 0 && transport.mode === 'demo', 'Slow old transport cleanup cannot adopt the generation of a newer request.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture();
  await transport.connectBluetooth();
  const stop = deferred<void>(); client.notifyStopGate = stop.promise;
  const oldCleanup = transport.disconnect();
  await until(() => client.notifyStops === 1);
  await transport.connectBluetooth();
  stop.resolve();
  await oldCleanup;
  check(client.disconnects.length === 0 && transport.connected, 'Slow old notification teardown cannot disconnect a newer connection to the same peripheral.');
  client.notifyStopGate = null;
  await transport.disconnect();
}
{
  const { client, transport } = fixture();
  await transport.connectBluetooth();
  client.writeFailAt = 0;
  const results = await Promise.allSettled([transport.setMode('image-match'), transport.scan()]);
  check(results.every(result => result.status === 'rejected'), 'Write failure rejects both the failing and queued command.');
  check(client.writes.length === 1 && !transport.connected, 'Partial write failure disconnects before any queued bytes can corrupt the command stream.');
}
{
  const { client, transport } = fixture();
  const discovery = transport.scanBluetooth();
  await until(() => !!client.scanCallback);
  client.scanCallback?.({ device: { deviceId: 'other', name: 'OTHER' } });
  client.scanCallback?.({ device, localName: 'CHROMA' });
  client.scanCallback?.({ device, localName: 'CHROMA' });
  const devices = await discovery;
  check(devices.length === 1 && devices[0].deviceId === device.deviceId, 'Discovery includes only exact CHROMA names and deduplicates advertisements.');
  check(client.scanStops === 1 && transport.getBleState().state === 'found', 'Timed discovery always stops the native scanner.');
  check(await transport.connectBluetooth(devices[0].deviceId) && client.chooserCalls === 0, 'A discovered selection connects directly without opening another chooser.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture();
  const discovery = transport.scanBluetooth();
  await until(() => !!client.scanCallback);
  await transport.disconnect();
  check((await discovery).length === 0 && client.scanStops === 1, 'Cancelling discovery stops exactly once and returns no stale devices.');
  client.scanCallback?.({ device });
  check(transport.getBleState().state === 'disconnected', 'Late scan advertisements cannot revive cancelled discovery.');
}
{
  const { transport, fallback, readings } = fixture();
  await transport.startDemo();
  await transport.scan();
  check(readings.length === 1 && readings[0].source === 'demo' && !transport.connected, 'The existing demo remains clearly simulated and functional.');
  let usbCalls = 0; let wifiAddress = '';
  fallback.connectUSB = async () => { usbCalls++; return true; };
  fallback.connectWifi = async address => { wifiAddress = address; return true; };
  check(await transport.connectUSB() && usbCalls === 1, 'USB continues through the existing transport.');
  check(await transport.connectWifi('ws://192.168.1.2:81') && wifiAddress === 'ws://192.168.1.2:81', 'Wi-Fi preserves its existing address and transport.');
  await transport.disconnect();
}


// Compact v1 parsing and session semantics; all packets are whole notifications.
for (const bad of ['', 'CHROMA_TEST', 'scan,1,2,3,4', 'SCAN,1,2,3', 'SCAN,1,2,3,4,5',
  'SCAN,,2,3,4', 'SCAN,-1,2,3,4', 'SCAN,256,2,3,4', 'SCAN,1.2,2,3,4',
  'SCAN,1e2,2,3,4', 'SCAN,0x10,2,3,4', 'SCAN,1,2,3,-4', 'SCAN,1,2,3,1.5',
  'SCAN,1,2,3,Infinity', 'SCAN,1,2,3,9007199254740992', 'REF,1,2', 'REF,1,2,3,4',
  'CMP,1,2,3,NaN', 'CMP,1,2,3,Infinity', 'CMP,1,2,3,-1', 'CMP,1,2,3,',
  'CMP,1,2,3,1e3', 'CMP,1,2,3,0x10', 'CMP,1,2,3,2.4junk', 'SCAN,' + '1'.repeat(129)]) {
  check(parseBlePacket(bad) === null, `Malformed compact packet is ignored: ${bad}`);
}
const compactScan = parseBlePacket('SCAN,224,53,77,630');
check(compactScan?.type === 'scan' && compactScan.hex === '#E0354D' && compactScan.clear === 630 &&
  compactScan.rgb.r === 224 && !!compactScan.hsl && !!compactScan.lab && !!compactScan.cmyk,
  'SCAN creates the existing colour model with all app-calculated conversions and clear.');
check(parseBlePacket(' SCAN, 0,255,0,0\r\n')?.type === 'scan', 'Surrounding whitespace, CRLF and channel endpoints are accepted.');
check(parseBlePacket('CMP,0,0,0,0')?.type === 'sample', 'Zero device Delta E is valid.');
{
  const { client, transport, rawData, errors } = fixture(CHROMA_BLE_CONFIG);
  const readings: DeviceReading[] = [], refs: ChromaReferenceMessage[] = [], results: ChromaCompareMessage[] = [];
  transport.addEventListener('reading', event => readings.push((event as CustomEvent).detail));
  transport.addEventListener('ble-reference', event => refs.push((event as CustomEvent).detail));
  transport.addEventListener('comparison', event => results.push((event as CustomEvent).detail));
  await transport.connectBluetooth();
  client.notify?.(view('CMP,220,55,80,2.4'));
  check(results.length === 0, 'CMP cannot reuse an absent reference.');
  client.notify?.(view('SCAN,224,53,77,630'));
  check(readings.length === 1 && readings[0].source === 'bluetooth' && readings[0].clear === 630 && readings[0].data?.hex === '#E0354D', 'A native SCAN emits a real reading with clear and the full scan model.');
  client.notify?.(view('REF,224,53,77'));
  check(refs.length === 1 && refs[0].hex === '#E0354D' && readings.length === 1, 'REF stores a reference without creating a scan.');
  client.notify?.(view('CMP,220,55,80,2.4'));
  check(results.length === 1 && results[0].reference.hex === '#E0354D' && results[0].sample.hex === '#DC3750' && results[0].deltaE === 2.4, 'CMP preserves the device Delta E and exact reference/sample pair.');
  client.notify?.(view('REF,999,2,3'));
  client.notify?.(view('CMP,220,55,80,0'));
  check(refs.length === 1 && results.at(-1)?.reference.hex === '#E0354D' && results.at(-1)?.deltaE === 0, 'Malformed REF cannot overwrite the last valid reference and zero Delta E is preserved.');
  client.notify?.(view('REF,10,20,30\r\nCMP,20,30,40,8.7\n'));
  check(results.at(-1)?.reference.hex === '#0A141E' && results.at(-1)?.sample.hex === '#141E28' && results.at(-1)?.deltaE === 8.7, 'Complete newline-separated REF/CMP packets in one notification retain order.');
  const before = readings.length;
  client.notify?.(view('SCAN,1,2,')); client.notify?.(view('3,630'));
  check(readings.length === before, 'Unframed partial messages are not guessed or concatenated.');
  check(rawData.at(-1)?.text === '3,630' && errors.length === 0, 'Raw preview still exposes rejected packets without crashing or protocol alerts.');
  check(client.writes.length === 0 && client.reads === 0, 'Native compact results require no JSON command or read.');
  const stale = client.notify;
  await transport.disconnect();
  await transport.connectBluetooth();
  const count = results.length;
  client.notify?.(view('CMP,1,2,3,4'));
  stale?.(view('REF,1,2,3'));
  client.notify?.(view('CMP,1,2,3,4'));
  check(results.length === count, 'Disconnect and stale callbacks cannot supply a reference to a new session.');
  client.notify?.(view('REF,0,0,0')); client.notify?.(view('CMP,255,255,255,100'));
  check(results.at(-1)?.reference.hex === '#000000' && results.at(-1)?.deltaE === 100, 'A reconnect accepts a fresh reference and sample.');
  await transport.disconnect();
}
// IMAGE MATCH is the single outbound command supported by compact v1 firmware.
const imageTarget: MatchTarget = { source: 'image', hex: '#B7D9F7', rgb: { r: 183, g: 217, b: 247 }, imageName: 'target.png' };
const imageCommand = { command: 'image-match-result' as const, rgb: imageTarget.rgb, deltaE00: 4.34 };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
check(decode(encodeImageMatchResultCommand(imageTarget.rgb, 4.34)) === 'IMR,183,217,247,4.3',
  'IMR encodes selected image RGB and one-decimal Delta E without JSON, spaces or LF.');
check(decode(encodeImageMatchResultCommand({ r: 0, g: 0, b: 0 }, 0)) === 'IMR,0,0,0,0.0', 'Black and zero Delta E are valid.');
check(encodeImageMatchResultCommand({ r: 255, g: 255, b: 255 }, 10).byteLength === 20, 'A full 20-byte IMR payload is accepted.');
for (const badRgb of [{ r: -1, g: 2, b: 3 }, { r: 256, g: 2, b: 3 }, { r: 1.5, g: 2, b: 3 },
  { r: NaN, g: 2, b: 3 }, { r: 1, g: Infinity, b: 3 }, { r: 1, g: 2, b: undefined },
  { r: '1', g: 2, b: 3 }, null]) {
  assert.throws(() => encodeImageMatchResultCommand(badRgb as unknown as MatchTarget['rgb'], 4.3), /Invalid/); checks++;
}
for (const badDelta of [NaN, Infinity, -Infinity, -1, '4.3', undefined, 1e21]) {
  assert.throws(() => encodeImageMatchResultCommand(imageTarget.rgb, badDelta as number), /Invalid|20-byte/); checks++;
}
assert.throws(() => encodeImageMatchResultCommand({ r: 255, g: 255, b: 255 }, 100), /20-byte/); checks++;
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  await rejects(() => transport.writeCommand(imageCommand), /connect|connected/i);
  check(client.writes.length === 0 && client.serviceRequests.length === 0, 'Unapproved disconnected IMR never accesses the command characteristic.');
  await transport.connectBluetooth();
  check(client.serviceRequests.length === 0, 'Connecting and receiving compact packets do not discover COMMAND capability.');
  await transport.writeCommand(imageCommand);
  check(client.writes.length === 1 && decode(client.writes[0]) === 'IMR,183,217,247,4.3',
    'Approved compact firmware receives one atomic UTF-8 IMR while legacy JSON remains disabled.');
  check(client.characteristicCalls.at(-1)?.service === CHROMA_SERVICE_UUID &&
    client.characteristicCalls.at(-1)?.characteristic === CHROMA_COMMAND_CHARACTERISTIC_UUID,
  'IMR uses the existing configured COMMAND service and characteristic.');
  await transport.writeCommand({ ...imageCommand, deltaE00: 5.2 });
  check(client.serviceRequests.length === 1 && client.serviceRequests[0] === device.deviceId, 'Writable discovery is cached only within the current BLE session.');
  await rejects(() => transport.writeCommand({ command: 'scan' }), /commands and reads are not defined yet/);
  await transport.disconnect();
  await rejects(() => transport.writeCommand(imageCommand), /connect|connected/i);
  check(client.writes.length === 2, 'Disconnect cannot send an IMR using the previous session.');
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  client.initError = new Error('Permission denied');
  await rejects(() => transport.connectBluetooth(), /Permission denied/);
  await rejects(() => transport.writeCommand(imageCommand), /connect|connected/i);
  check(client.writes.length === 0 && client.serviceRequests.length === 0, 'Permission denial never reaches IMR discovery or writing.');
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  const gate = deferred<void>(); client.notifyGate = gate.promise;
  const connecting = transport.connectBluetooth();
  await until(() => client.notifyStarts === 1);
  await rejects(() => transport.writeCommand(imageCommand), /approved|connect/i);
  check(client.writes.length === 0 && client.serviceRequests.length === 0, 'IMR waits for completed approval and notification readiness.');
  gate.resolve(); await connecting; await transport.disconnect();
}
for (const mismatch of ['service', 'characteristic', 'write']) {
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  if (mismatch === 'service') client.services[0] = { ...client.services[0], uuid: CHROMA_DATA_CHARACTERISTIC_UUID };
  if (mismatch === 'characteristic') client.services[0].characteristics[0] = {
    ...client.services[0].characteristics[0], uuid: CHROMA_DATA_CHARACTERISTIC_UUID };
  if (mismatch === 'write') client.services[0].characteristics[0] = { ...client.services[0].characteristics[0],
    properties: { ...client.services[0].characteristics[0].properties, write: false, writeWithoutResponse: true } };
  await transport.connectBluetooth();
  await rejects(() => transport.writeCommand(imageCommand), /not writable/);
  check(client.writes.length === 0 && transport.connected, `IMR fails safely for an incompatible ${mismatch} capability.`);
  await transport.disconnect();
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  await transport.connectBluetooth();
  await rejects(() => transport.writeCommand({ ...imageCommand, rgb: { r: NaN, g: 217, b: 247 } }), /Invalid/);
  await rejects(() => transport.writeCommand({ ...imageCommand, rgb: { r: 255, g: 255, b: 255 }, deltaE00: 100 }), /20-byte/);
  check(client.writes.length === 0 && client.serviceRequests.length === 0 && transport.connected, 'Invalid or oversized IMR is rejected before any BLE access.');
  client.servicesError = new Error('Discovery failed');
  await rejects(() => transport.writeCommand(imageCommand), /Discovery failed/);
  check(transport.connected && client.writes.length === 0, 'A failed COMMAND property lookup preserves the current connection.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  await transport.connectBluetooth();
  const gate = deferred<void>(); client.servicesGate = gate.promise;
  const oldWrite = rejects(() => transport.writeCommand(imageCommand), /disconnected/i);
  await until(() => client.serviceRequests.length === 1);
  await transport.disconnect(); await transport.connectBluetooth();
  client.servicesGate = null; gate.resolve(); await oldWrite;
  check(client.writes.length === 0, 'A capability lookup completing after reconnect cannot write a stale result into the new session.');
  await transport.writeCommand(imageCommand);
  check(client.serviceRequests.length === 2 && client.writes.length === 1, 'The new session rechecks its own COMMAND writability.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  await transport.connectBluetooth(); client.writeFailAt = 0;
  const outcomes = await Promise.allSettled([transport.writeCommand(imageCommand), transport.writeCommand({ ...imageCommand, deltaE00: 5.2 })]);
  check(outcomes[0].status === 'rejected' && outcomes[1].status === 'fulfilled' && transport.connected,
    'An atomic IMR write failure does not disconnect or poison the existing command queue.');
  check(client.writes.length === 2 && client.writes.every(bytes => bytes.byteLength <= 20), 'Queued IMR commands each remain a single compact payload.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  const service = new DeviceService(transport);
  const missingScan: DeviceReading = { hex: '#B7D9F0', source: 'bluetooth', timestamp: new Date().toISOString() };
  check(!await service.sendImageMatchResult(imageTarget, missingScan, 4.34), 'Disconnected Image Match is a quiet no-op.');
  await transport.connectBluetooth();
  check(!await service.sendImageMatchResult(imageTarget, missingScan, 4.34), 'A persisted sample without a scan in this session cannot send IMR.');
  client.notify?.(view('SCAN,183,217,240,630'));
  const sample = service.getReading()!;
  const existingDelta = deltaE(imageTarget.hex, sample.hex);
  check(await service.sendImageMatchResult(imageTarget, sample, existingDelta), 'A completed image target and current physical scan sends IMR.');
  check(decode(client.writes[0]) === `IMR,183,217,247,${existingDelta.toFixed(1)}` && sample.data?.rgb.b === 240,
    'IMR transmits the existing CIEDE2000 value and target blue 247 rather than physical sample blue 240.');
  const changedMetadata = { ...imageTarget, rgb: { ...imageTarget.rgb }, name: 'Renamed target', imageName: 'other-name.png' };
  check(!await service.sendImageMatchResult(changedMetadata, { ...sample, name: 'Renamed scan' }, existingDelta),
    'Rerender-equivalent objects and unrelated target/sample metadata do not resend IMR.');
  const competing = await Promise.all([service.sendImageMatchResult(imageTarget, sample, existingDelta + 0.001),
    service.sendImageMatchResult(imageTarget, { ...sample }, existingDelta + 0.001)]);
  check(competing.filter(Boolean).length === 1 && client.writes.length === 2, 'The result is claimed before awaiting BLE, so simultaneous duplicate effects send once.');
  for (const [target, reading, difference] of [
    [{ ...imageTarget, source: 'library' }, sample, existingDelta],
    [imageTarget, { ...sample, source: 'demo' }, existingDelta],
    [imageTarget, { ...sample, source: 'usb' }, existingDelta],
    [{ ...imageTarget, rgb: { r: 183, g: 217, b: 248 } }, sample, existingDelta],
    [imageTarget, { ...sample, timestamp: 'invalid' }, existingDelta],
    [imageTarget, sample, NaN], [imageTarget, sample, -1],
  ] as Array<[MatchTarget, DeviceReading, number]>) {
    check(!await service.sendImageMatchResult(target, reading, difference), 'An invalid or ineligible comparison cannot transmit.');
  }
  check(client.writes.length === 2, 'Rejected comparisons never write to COMMAND.');
  await new Promise(resolve => setTimeout(resolve, 2));
  client.notify?.(view('SCAN,183,217,240,630'));
  const newerSample = service.getReading()!;
  check(newerSample.timestamp !== sample.timestamp && await service.sendImageMatchResult(imageTarget, newerSample, existingDelta),
    'A new completed physical scan is transmitted even when its RGB and Delta E match the previous scan.');
  await transport.disconnect(); await transport.connectBluetooth();
  check(!await service.sendImageMatchResult(imageTarget, newerSample, existingDelta) && client.writes.length === 3,
    'Reconnect cannot resend an image result from the previous scan session.');
  await transport.disconnect();
}
{
  const { client, transport } = fixture(CHROMA_BLE_CONFIG);
  const service = new DeviceService(transport);
  const failures: string[] = [];
  service.addEventListener('error', event => { const message = (event as CustomEvent).detail.message; if (message) failures.push(message); });
  await transport.connectBluetooth(); client.notify?.(view('SCAN,1,2,3,630'));
  const sample = service.getReading()!;
  client.writeFailAt = 0;
  check(!await service.sendImageMatchResult(imageTarget, sample, 4.34), 'A BLE write failure resolves safely instead of escaping into Image Match.');
  check(failures.some(message => /Image Match.*Radio write failed/.test(message)) && transport.connected,
    'A write failure uses the existing service error event while preserving the BLE session.');
  check(!await service.sendImageMatchResult({ ...imageTarget }, { ...sample }, 4.34) && client.writes.length === 1,
    'The failed result remains claimed so error-related rerenders do not retry indefinitely.');
  check(await service.sendImageMatchResult(imageTarget, sample, 4.44) && decode(client.writes.at(-1)!) === 'IMR,183,217,247,4.4',
    'A genuinely changed completed comparison can send after the previous write failure.');
  await transport.disconnect();
}
console.log(`Native BLE: ${checks} checks passed (mocked client; no physical device or permissions used).`);
