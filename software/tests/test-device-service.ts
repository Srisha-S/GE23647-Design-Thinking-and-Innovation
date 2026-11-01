import assert from 'node:assert/strict';
import { DeviceService } from '../src/services/DeviceService';
import type { DeviceReading, DeviceStatus } from '../src/types';

// The UI adapter is exercised separately from the tested ESP32 transports.
// No browser chooser, physical device or network is involved.
class MockTransport extends EventTarget {
  mode: DeviceStatus['mode'] = 'disconnected';
  scanCalls = 0;
  sentModes: string[] = [];
  get connected() { return this.mode === 'usb' || this.mode === 'wifi' || this.mode === 'bluetooth'; }
  status(mode: DeviceStatus['mode']) {
    this.mode = mode;
    this.dispatchEvent(new CustomEvent('status', { detail: { mode, connected: this.connected } }));
  }
  async startDemo() { this.status('demo'); }
  async connectUSB() { this.status('usb'); return true; }
  async connectBluetooth() { this.status('bluetooth'); return true; }
  async connectWifi(_address: string) { this.status('wifi'); return true; }
  async disconnect() { this.status('disconnected'); }
  async scan(): Promise<DeviceReading | null> { this.scanCalls++; return null; }
  async setMode(mode: string) { this.sentModes.push(mode); }
  receive(detail: DeviceReading) { this.dispatchEvent(new CustomEvent('reading', { detail })); }
  receiveBleText(text: string) { this.dispatchEvent(new CustomEvent('ble-data', { detail: { text } })); }
  acknowledge(mode: string) { this.dispatchEvent(new CustomEvent('device-mode', { detail: { mode } })); }
}

let checks = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); checks++; }
const transport = new MockTransport();
const service = new DeviceService(transport);
const errors: Array<string | null> = [];
const readings: DeviceReading[] = [];
service.addEventListener('error', event => errors.push((event as CustomEvent).detail.message));
service.addEventListener('reading', event => readings.push((event as CustomEvent).detail));

check(service.getStatus().mode === 'disconnected', 'Service starts disconnected.');
check(await service.scanColour() === null && transport.scanCalls === 0, 'Disconnected scan never sends a command.');
check(errors.at(-1)?.includes('Connect CHROMA'), 'Disconnected scan reports a useful error.');
await service.connectDevice('demo');
check(!service.getStatus().connected && service.getStatus().label.includes('simulated'), 'Demo is explicitly simulated, never physically connected.');
check(service.getBattery() === 78 && service.getFirmware() === 'v1.0', 'Mock battery and firmware are available in demo mode.');

await service.connectDevice('usb');
check(service.getStatus().connected && service.getBattery() === null && service.getFirmware() === null, 'Real device metadata is unknown until reported.');
const pending = service.scanColour();
const repeated = service.scanColour();
check(pending === repeated && transport.scanCalls === 1, 'Duplicate scan callers share one promise and one hardware command.');
await Promise.resolve();
check(service.isScanning(), 'Sending a command does not complete a physical scan.');
const sample = { hex: '#C76B4A', source: 'usb', timestamp: new Date().toISOString(), deviceMode: 'compare' };
transport.receive(sample);
const result = await pending;
check(result?.hex === sample.hex && result?.deviceMode === 'compare', 'An incoming reading completes the scan and preserves hardware mode.');
check(result?.name === 'Terracotta' && !service.isScanning(), 'Readings are named and the pending UI is released.');
transport.receive({ ...sample, hex: '#D4808E' });
check(readings.length === 2 && service.getReading()?.hex === '#D4808E', 'Hardware-initiated readings update the workspace without a website scan.');

await service.setActiveMode('compare');
transport.acknowledge('compare');
await service.setActiveMode('compare');
check(transport.sentModes.length === 1, 'Acknowledgements and repeated mode requests do not create command loops.');
transport.acknowledge('image-match');
check(service.getActiveMode() === 'image-match' && transport.sentModes.length === 1, 'Hardware mode changes update state without echoing a command.');

const cancelled = service.scanColour();
await service.disconnectDevice();
check(await cancelled === null && !service.isScanning(), 'Disconnect releases a pending physical scan.');
await assert.rejects(() => service.calibrateDevice(), /Connect CHROMA/); checks++;
await service.connectDevice('wifi', 'ws://device.test:81');
const calibration = service.calibrateDevice();
check(service.getCalibration() === 'running', 'Calibration exposes a running state.');
await service.disconnectDevice();
await calibration;
check(service.getCalibration() === 'idle', 'Disconnect cancels the calibration preview.');
await service.connectDevice('demo');
await service.calibrateDevice();
check(service.getCalibration() === 'complete' && transport.scanCalls === 2, 'Calibration preview completes without sending sensor commands.');

await service.connectDevice('bluetooth');
check(service.getStatus().connected && service.getStatus().mode === 'bluetooth' && service.getStatus().label.includes('Bluetooth'), 'BLE readiness is exposed as a physical Bluetooth connection.');
check(service.getBattery() === null && service.getFirmware() === null, 'BLE does not inherit simulated battery or firmware metadata.');
const rawBleEvents: Array<string | null> = [];
service.addEventListener('ble-data', event => rawBleEvents.push((event as CustomEvent).detail.text));
check(service.getLatestBleData() === null, 'BLE debug text starts empty.');
const readingBeforeText = service.getReading();
const readingCountBeforeText = readings.length;
transport.receiveBleText('CHROMA_TEST');
check(service.getLatestBleData() === 'CHROMA_TEST' && rawBleEvents.at(-1) === 'CHROMA_TEST', 'Raw BLE text is stored and forwarded to the UI.');
transport.receiveBleText('<script>alert(1)</script>\nColour: café 🎨');
check(service.getLatestBleData() === '<script>alert(1)</script>\nColour: café 🎨', 'The debug boundary preserves arbitrary text, Unicode and line breaks.');
check(service.getReading() === readingBeforeText && readings.length === readingCountBeforeText, 'Raw BLE notifications never become colour readings.');
const bluetoothScan = service.scanColour();
transport.receiveBleText('{"hex":"#112233"}');
check(service.isScanning() && readings.length === readingCountBeforeText, 'Even colour-shaped raw text does not parse or complete a scan.');
transport.receive({ ...sample, source: 'bluetooth' });
check((await bluetoothScan)?.source === 'bluetooth' && !service.isScanning(), 'BLE readings complete scans and retain their physical source.');
const interruptedBluetoothScan = service.scanColour();
transport.status('disconnected');
check(await interruptedBluetoothScan === null && !service.isScanning(), 'BLE link loss releases a pending scan.');
check(service.getLatestBleData() === null && rawBleEvents.at(-1) === null, 'BLE link loss clears the displayed text.');
transport.receiveBleText('EARLY_NOTIFICATION');
transport.status('bluetooth');
check(service.getLatestBleData() === 'EARLY_NOTIFICATION', 'Notifications received during subscription survive the connected status event.');
transport.receiveBleText('');
check(service.getLatestBleData() === '' && rawBleEvents.at(-1) === '', 'An empty BLE text payload is distinct from receiving no data.');
for (const nextMode of ['demo', 'usb', 'wifi'] as const) {
  transport.status('bluetooth');
  transport.receiveBleText('PREVIOUS_SESSION');
  transport.status(nextMode);
  check(service.getLatestBleData() === null && rawBleEvents.at(-1) === null, `Switching to ${nextMode} clears previous BLE debug text.`);
}
transport.status('bluetooth');
transport.receiveBleText('DISCONNECT_TEST');
await service.disconnectDevice();
check(service.getLatestBleData() === null && rawBleEvents.at(-1) === null, 'Explicit disconnect clears BLE debug text.');


await service.connectDevice('bluetooth');
const waitingForReference = service.scanColour();
const reference = { type: 'reference', rgb: { r: 224, g: 53, b: 77 }, hex: '#E0354D' };
transport.dispatchEvent(new CustomEvent('ble-reference', { detail: reference }));
check(service.getBleReference()?.hex === '#E0354D' && service.getBleComparison() === null, 'The service exposes a reference independently from scan readings.');
check(await waitingForReference === null && !service.isScanning(), 'A device REF completes a pending comparison wait without inventing a scan.');
const waitingForComparison = service.scanColour();
const comparison = { type: 'compare', reference, sample: { rgb: { r: 220, g: 55, b: 80 }, hex: '#DC3750' }, deltaE: 2.4 };
transport.dispatchEvent(new CustomEvent('comparison', { detail: comparison }));
check(await waitingForComparison === null && !service.isScanning(), 'A device CMP releases a pending comparison wait without overwriting its device result.');
check(service.getBleComparison()?.deltaE === 2.4, 'Device comparison values reach the UI service unchanged.');
transport.dispatchEvent(new CustomEvent('ble-reference', { detail: reference }));
check(service.getBleComparison() === null, 'A new reference invalidates the previous result.');
await service.disconnectDevice();
check(service.getBleReference() === null && service.getBleComparison() === null, 'Disconnect clears session comparison state.');

// Accelerate only the documented timeout to keep this boundary test fast.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
  realSetTimeout(callback, delay === 12_000 ? 5 : delay, ...args)) as typeof setTimeout;
try {
  await service.connectDevice('usb');
  const timeout = await service.scanColour();
  check(timeout === null && !service.isScanning(), 'A silent device has a bounded scan wait.');
  check(errors.at(-1)?.includes('No colour arrived'), 'A timed-out scan gives a useful recovery message.');
} finally {
  globalThis.setTimeout = realSetTimeout;
  await service.disconnectDevice();
}
console.log(`${checks} device service checks passed.`);
