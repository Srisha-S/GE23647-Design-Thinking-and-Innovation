import type { ChromaBleConfig } from './src/config/ble';

export interface TransportReading {
  hex: string;
  name?: string;
  source: string;
  timestamp: string;
  deviceMode?: string;
}

export const CHROMA_BLE: Readonly<{
  service: string;
  write: string;
  notify: string;
}>;

/** Existing, independently tested ESP32 transport. The React service wraps it. */
export class ChromaDevice extends EventTarget {
  constructor(bleConfig?: ChromaBleConfig);
  readonly mode: 'demo' | 'usb' | 'wifi' | 'bluetooth' | 'disconnected';
  readonly connected: boolean;
  startDemo(): Promise<void>;
  connectUSB(): Promise<boolean>;
  connectBluetooth(): Promise<boolean>;
  connectWifi(address: string): Promise<boolean>;
  disconnect(): Promise<void>;
  scan(): Promise<TransportReading | null>;
  setMode(mode: string): Promise<void>;
}
