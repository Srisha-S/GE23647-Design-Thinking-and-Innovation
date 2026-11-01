import { Capacitor } from '@capacitor/core';
import { ChromaDevice } from '../../device.js';
import { NativeBleTransport } from './NativeBleTransport';

/** Keep native radio APIs out of the website's existing browser transport. */
export function createDeviceTransport(): ChromaDevice | NativeBleTransport {
  return Capacitor.isNativePlatform() ? new NativeBleTransport() : new ChromaDevice();
}

export const isNativeApp = () => Capacitor.isNativePlatform();
