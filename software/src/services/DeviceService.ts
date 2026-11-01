import { ChromaDevice } from '../../device.js';
import { createDeviceTransport, isNativeApp } from './deviceTransport';
import { NativeBleTransport, type BleConnectionState } from './NativeBleTransport';
import { nearestName } from '../lib/color';
import type { DeviceReading, DeviceStatus, MatchTarget } from '../types';
import { encodeImageMatchResultCommand, isDeviceColourData, type ChromaReferenceMessage, type ChromaCompareMessage } from '../types/deviceProtocol';

export type CalibrationState = 'idle' | 'running' | 'complete';
const SCAN_TIMEOUT_MS = 12_000;

/**
 * UI-facing device boundary. Demo readings and live USB/Wi-Fi/Bluetooth input
 * share the same events and colour workflows.
 */
export class DeviceService extends EventTarget {
  private transport: ChromaDevice;
  private status: DeviceStatus = {
    mode: 'disconnected', connected: false, label: 'Device disconnected',
    battery: null, firmware: null,
  };
  private pendingScan: {
    promise: Promise<DeviceReading | null>;
    resolve: (reading: DeviceReading | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private calibrationTask: {
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  } | null = null;
  private mode = 'scan';
  private lastReading: DeviceReading | null = null;
  private imageMatchScan: DeviceReading | null = null;
  private lastImageMatchResult: string | null = null;
  private latestBleData: string | null = null;
  private bleReference: ChromaReferenceMessage | null = null;
  private bleComparison: ChromaCompareMessage | null = null;
  private calibration: CalibrationState = 'idle';

  readonly isNative = isNativeApp();

  getBleState(): BleConnectionState {
    return this.transport instanceof NativeBleTransport ? this.transport.getBleState() : {
      state: this.status.mode === 'bluetooth' ? 'connected' : 'available',
      label: this.status.mode === 'bluetooth' ? 'Connected to CHROMA' : 'Bluetooth available',
      configured: true,
    };
  }

  constructor(transport: ChromaDevice = createDeviceTransport()) {
    super();
    this.transport = transport;
    transport.addEventListener('status', this.handleStatus);
    transport.addEventListener('reading', this.handleReading);
    transport.addEventListener('error', this.handleError);
    transport.addEventListener('device-mode', this.handleMode);
    transport.addEventListener('ble-state', (event) => this.emit('ble-state', (event as CustomEvent<BleConnectionState>).detail));
    transport.addEventListener('ble-data', this.handleBleData);
    transport.addEventListener('ble-reference', this.handleBleReference);
    transport.addEventListener('comparison', this.handleBleComparison);
  }

  private emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private handleStatus = (event: Event) => {
    const incoming = (event as CustomEvent<{ mode: DeviceStatus['mode']; connected: boolean }>).detail;
    const labels: Record<DeviceStatus['mode'], string> = {
      demo: 'Demo mode · simulated', usb: 'CHROMA connected · USB',
      wifi: 'CHROMA connected · Wi-Fi', bluetooth: 'CHROMA connected · Bluetooth',
      disconnected: 'Device disconnected',
    };
    this.status = {
      mode: incoming.mode,
      // Demo must never masquerade as a real hardware connection.
      connected: incoming.connected && ['usb', 'wifi', 'bluetooth'].includes(incoming.mode),
      label: labels[incoming.mode],
      battery: incoming.mode === 'demo' ? 78 : null,
      firmware: incoming.mode === 'demo' ? 'v1.0' : null,
    };
    if (incoming.mode !== 'bluetooth' || !incoming.connected) {
      this.imageMatchScan = null;
      this.lastImageMatchResult = null;
    }
    // Notifications may arrive during subscription, before Bluetooth readiness.
    // Preserve those on connection, but never carry text into another session.
    if (incoming.mode !== 'bluetooth' && this.latestBleData !== null) {
      this.latestBleData = null;
      this.emit('ble-data', { text: null });
    }
    if (incoming.mode === 'disconnected') {
      this.finishScan(null);
      this.cancelCalibration();
    }
    if (incoming.mode !== 'bluetooth') {
      this.bleReference = null;
      this.bleComparison = null;
      this.emit('ble-reference', null);
      this.emit('ble-comparison', null);
    }
    this.emit('status', this.status);
  };

  private handleReading = (event: Event) => {
    const data = (event as CustomEvent<DeviceReading>).detail;
    this.lastReading = { ...data, name: data.name || nearestName(data.hex) };
    if (this.status.mode === 'bluetooth' && this.status.connected && data.source === 'bluetooth') {
      this.imageMatchScan = this.lastReading;
    }
    this.emit('error', { message: null });
    this.emit('reading', this.lastReading);
    this.finishScan(this.lastReading);
  };

  private handleBleData = (event: Event) => {
    const text = (event as CustomEvent<{ text: string }>).detail.text;
    if (typeof text !== 'string') return;
    this.latestBleData = text;
    // Raw text is deliberately separate from colour readings and scan results.
    this.emit('ble-data', { text });
  };

  private handleBleReference = (event: Event) => {
    this.bleReference = (event as CustomEvent<ChromaReferenceMessage>).detail;
    this.bleComparison = null;
    this.emit('ble-reference', this.bleReference);
    this.emit('ble-comparison', null);
    this.finishScan(null);
    this.emit('error', { message: null });
  };

  private handleBleComparison = (event: Event) => {
    this.bleComparison = (event as CustomEvent<ChromaCompareMessage>).detail;
    this.emit('ble-comparison', this.bleComparison);
    this.finishScan(null);
    this.emit('error', { message: null });
  };

  private handleError = (event: Event) => {
    this.emit('error', (event as CustomEvent<{ message: string }>).detail);
  };

  private handleMode = (event: Event) => {
    const incoming = (event as CustomEvent<{ mode: string }>).detail.mode;
    if (incoming === this.mode) return;
    this.mode = incoming;
    // A hardware acknowledgement updates local state only. Never echo it back.
    this.emit('mode', { mode: incoming, origin: 'device' });
  };

  getStatus(): DeviceStatus { return { ...this.status }; }
  getBattery(): number | null { return this.status.battery; }
  getFirmware(): string | null { return this.status.firmware; }
  getReading(): DeviceReading | null { return this.lastReading; }
  getLatestBleData(): string | null { return this.latestBleData; }
  getBleReference(): ChromaReferenceMessage | null { return this.bleReference; }
  getBleComparison(): ChromaCompareMessage | null { return this.bleComparison; }
  getActiveMode(): string { return this.mode; }
  getCalibration(): CalibrationState { return this.calibration; }
  isScanning(): boolean { return this.pendingScan !== null; }

  async sendImageMatchResult(target: MatchTarget, sample: DeviceReading, deltaE00: number): Promise<boolean> {
    if (!(this.transport instanceof NativeBleTransport) || this.status.mode !== 'bluetooth' ||
      !this.status.connected || this.getBleState().state !== 'connected' || this.pendingScan || target?.source !== 'image' ||
      sample?.source !== 'bluetooth' || !this.imageMatchScan ||
      sample.hex !== this.imageMatchScan.hex || sample.timestamp !== this.imageMatchScan.timestamp) return false;
    if (!isDeviceColourData(target) || typeof sample.hex !== 'string' || !/^#[\da-f]{6}$/i.test(sample.hex) ||
      typeof sample.timestamp !== 'string' || !Number.isFinite(Date.parse(sample.timestamp))) return false;
    try {
      encodeImageMatchResultCommand(target.rgb, deltaE00);
      const identity = JSON.stringify([target.rgb.r, target.rgb.g, target.rgb.b, sample.hex, sample.timestamp, deltaE00]);
      if (identity === this.lastImageMatchResult) return false;
      // Claim before awaiting BLE so rerenders, including after a failed write,
      // cannot repeatedly transmit the same completed comparison.
      this.lastImageMatchResult = identity;
      await this.transport.writeCommand({ command: 'image-match-result', rgb: target.rgb, deltaE00 });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', { message: `Image Match result could not be sent to CHROMA: ${message}` });
      return false;
    }
  }

  async connectDevice(kind: 'demo' | 'usb' | 'wifi' | 'bluetooth' = 'demo', url?: string): Promise<void> {
    this.emit('error', { message: null });
    if (kind === 'demo') await this.transport.startDemo();
    else if (kind === 'usb') await this.transport.connectUSB();
    else if (kind === 'bluetooth') await this.transport.connectBluetooth();
    else await this.transport.connectWifi(url || '');
  }

  async disconnectDevice(): Promise<void> {
    // Release awaiting scan/calibration UIs before asynchronous port teardown.
    this.finishScan(null);
    this.cancelCalibration();
    await this.transport.disconnect();
  }

  scanColour(): Promise<DeviceReading | null> {
    if (this.pendingScan) return this.pendingScan.promise;
    if (this.status.mode === 'disconnected') {
      this.emit('error', { message: 'Connect CHROMA or enable demo mode before scanning.' });
      return Promise.resolve(null);
    }
    this.emit('error', { message: null });
    let resolve!: (reading: DeviceReading | null) => void;
    const promise = new Promise<DeviceReading | null>((done) => { resolve = done; });
    const timer = setTimeout(() => {
      this.emit('error', { message: 'No colour arrived from CHROMA. Check the sensor and try scanning again.' });
      this.finishScan(null);
    }, SCAN_TIMEOUT_MS);
    const request = { promise, resolve, timer };
    this.pendingScan = request;
    this.emit('scanning', true);
    // A real transport scan sends a command; its reading arrives separately.
    // Demo also emits a reading, so both paths complete in handleReading.
    void this.transport.scan().catch((error: unknown) => {
      // A delayed failure from a cancelled request must not cancel a new scan.
      if (this.pendingScan !== request) return;
      this.emit('error', { message: error instanceof Error ? error.message : 'The scan could not be completed.' });
      this.finishScan(null);
    });
    return promise;
  }

  private finishScan(reading: DeviceReading | null) {
    if (!this.pendingScan) return;
    const pending = this.pendingScan;
    this.pendingScan = null;
    clearTimeout(pending.timer);
    pending.resolve(reading);
    this.emit('scanning', false);
  }

  async setActiveMode(mode: string): Promise<void> {
    const normalized = mode === 'image' ? 'image-match' : mode;
    if (!['scan', 'compare', 'convert', 'image-match'].includes(normalized)) return;
    if (this.mode === normalized) return;
    await this.transport.setMode(normalized);
    this.mode = normalized;
    this.emit('mode', { mode: normalized, origin: 'website' });
  }

  async calibrateDevice(): Promise<void> {
    if (this.status.mode === 'disconnected') {
      throw new Error('Connect CHROMA or enable demo mode to preview calibration.');
    }
    if (this.calibrationTask) return;
    this.emit('error', { message: null });
    this.calibration = 'running';
    this.emit('calibration', this.calibration);
    // Deliberately a UI prototype. No calibration command or sensor write.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.calibrationTask = null;
        this.calibration = 'complete';
        this.emit('calibration', this.calibration);
        resolve();
      }, 1_100);
      this.calibrationTask = { timer, resolve };
    });
  }

  private cancelCalibration() {
    if (this.calibrationTask) {
      clearTimeout(this.calibrationTask.timer);
      this.calibrationTask.resolve();
      this.calibrationTask = null;
    }
    this.calibration = 'idle';
    this.emit('calibration', this.calibration);
  }
}
