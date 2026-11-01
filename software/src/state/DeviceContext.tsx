import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DeviceService, type CalibrationState } from '../services/DeviceService';
import type { DeviceReading, DeviceStatus, MatchTarget } from '../types';
import type { BleConnectionState } from '../services/NativeBleTransport';
import type { ChromaReferenceMessage, ChromaCompareMessage } from '../types/deviceProtocol';

interface DeviceContextValue {
  status: DeviceStatus;
  reading: DeviceReading | null;
  scanning: boolean;
  activeMode: string;
  calibration: CalibrationState;
  error: string | null;
  bleState: BleConnectionState;
  latestBleData: string | null;
  bleReference: ChromaReferenceMessage | null;
  bleComparison: ChromaCompareMessage | null;
  isNative: boolean;
  scanColour(): Promise<DeviceReading | null>;
  sendImageMatchResult(target: MatchTarget, sample: DeviceReading, deltaE00: number): Promise<boolean>;
  connectDevice(kind: 'demo' | 'usb' | 'wifi' | 'bluetooth', url?: string): Promise<void>;
  disconnectDevice(): Promise<void>;
  setActiveMode(mode: string): Promise<void>;
  calibrateDevice(): Promise<void>;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [service] = useState(() => new DeviceService());
  const [status, setStatus] = useState(service.getStatus());
  const [reading, setReading] = useState<DeviceReading | null>(null);
  const [scanning, setScanning] = useState(false);
  const [activeMode, setMode] = useState('scan');
  const [calibration, setCalibration] = useState<CalibrationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bleState, setBleState] = useState(service.getBleState());
  const [latestBleData, setLatestBleData] = useState(service.getLatestBleData());
  const [bleReference, setBleReference] = useState(service.getBleReference());
  const [bleComparison, setBleComparison] = useState(service.getBleComparison());

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<DeviceStatus>).detail);
    const onReading = (event: Event) => setReading((event as CustomEvent<DeviceReading>).detail);
    const onScanning = (event: Event) => setScanning((event as CustomEvent<boolean>).detail);
    const onMode = (event: Event) => setMode((event as CustomEvent<{ mode: string }>).detail.mode);
    const onCalibration = (event: Event) => setCalibration((event as CustomEvent<CalibrationState>).detail);
    const onError = (event: Event) => setError((event as CustomEvent<{ message: string | null }>).detail.message);
    const onBleState = (event: Event) => setBleState((event as CustomEvent<BleConnectionState>).detail);
    const onBleData = (event: Event) => setLatestBleData((event as CustomEvent<{ text: string | null }>).detail.text);
    const onBleReference = (event: Event) => setBleReference((event as CustomEvent<ChromaReferenceMessage | null>).detail);
    const onBleComparison = (event: Event) => setBleComparison((event as CustomEvent<ChromaCompareMessage | null>).detail);
    const listeners: Array<[string, EventListener]> = [
      ['status', onStatus], ['reading', onReading], ['scanning', onScanning],
      ['mode', onMode], ['calibration', onCalibration], ['error', onError],
      ['ble-state', onBleState], ['ble-data', onBleData],
      ['ble-reference', onBleReference], ['ble-comparison', onBleComparison],
    ];
    listeners.forEach(([name, listener]) => service.addEventListener(name, listener));
    void service.connectDevice('demo').catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not start the demo.');
    });
    return () => {
      listeners.forEach(([name, listener]) => service.removeEventListener(name, listener));
      void service.disconnectDevice();
    };
  }, [service]);

  const connectDevice = useCallback(async (kind: 'demo' | 'usb' | 'wifi' | 'bluetooth', url?: string) => {
    try { await service.connectDevice(kind, url); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not connect to CHROMA.');
    }
  }, [service]);
  const scanColour = useCallback(() => service.scanColour(), [service]);
  const sendImageMatchResult = useCallback((target: MatchTarget, sample: DeviceReading, deltaE00: number) =>
    service.sendImageMatchResult(target, sample, deltaE00), [service]);
  const disconnectDevice = useCallback(() => service.disconnectDevice(), [service]);
  const setActiveMode = useCallback(async (mode: string) => {
    try { await service.setActiveMode(mode); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not change device mode.'); }
  }, [service]);
  const calibrateDevice = useCallback(async () => {
    try { await service.calibrateDevice(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not preview calibration.'); }
  }, [service]);

  return (
    <DeviceContext.Provider value={{ status, reading, scanning, activeMode, calibration, error, bleState, latestBleData, bleReference, bleComparison, isNative: service.isNative,
      scanColour, sendImageMatchResult, connectDevice, disconnectDevice, setActiveMode, calibrateDevice }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  const context = useContext(DeviceContext);
  if (!context) throw new Error('useDevice must be used within DeviceProvider.');
  return context;
}
