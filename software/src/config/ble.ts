/**
 * Permanent firmware identifiers shared by Android and the website.
 * Native notifications use compact SCAN/REF/CMP packets. The old JSON prototype
 * is disabled; the website retains its existing connection-only BLE behaviour.
 */
export const CHROMA_SERVICE_UUID: string = '9f1c0001-5a7e-4c4d-b2a1-8f4d1c2e3a40';
export const CHROMA_DATA_CHARACTERISTIC_UUID: string = '9f1c0002-5a7e-4c4d-b2a1-8f4d1c2e3a40';
export const CHROMA_COMMAND_CHARACTERISTIC_UUID: string = '9f1c0003-5a7e-4c4d-b2a1-8f4d1c2e3a40';
export const CHROMA_DEVICE_NAME = 'CHROMA';

export interface ChromaBleConfig {
  deviceName: string;
  serviceUUID: string;
  dataCharacteristicUUID: string;
  commandCharacteristicUUID: string;
  scanDurationMs: number;
  connectTimeoutMs: number;
  /** Legacy JSON prototype opt-in only. Keep false for native compact BLE v1. */
  colourProtocolEnabled: boolean;
}

export const CHROMA_BLE_CONFIG: Readonly<ChromaBleConfig> = Object.freeze({
  deviceName: CHROMA_DEVICE_NAME,
  serviceUUID: CHROMA_SERVICE_UUID,
  dataCharacteristicUUID: CHROMA_DATA_CHARACTERISTIC_UUID,
  commandCharacteristicUUID: CHROMA_COMMAND_CHARACTERISTIC_UUID,
  scanDurationMs: 12_000,
  connectTimeoutMs: 15_000,
  colourProtocolEnabled: false,
});

export function hasBleDataConfiguration(config: ChromaBleConfig = CHROMA_BLE_CONFIG): boolean {
  const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  return [config.serviceUUID, config.dataCharacteristicUUID, config.commandCharacteristicUUID]
    .every(value => uuid.test(value));
}
