/** App-side colour models. Native BLE v1 wire packets are compact CSV, not JSON. */
export interface DeviceColourData {
  rgb: { r: number; g: number; b: number };
  hex: string;
  hsl?: { h: number; s: number; l: number };
  lab?: { l: number; a: number; b: number };
  cmyk?: { c: number; m: number; y: number; k: number };
  clear?: number;
}

export interface ChromaScanMessage extends DeviceColourData { type: 'scan' }
export interface ChromaReferenceMessage extends DeviceColourData { type: 'reference' }
export interface ChromaCompareMessage {
  type: 'compare';
  reference: DeviceColourData;
  sample: DeviceColourData;
  deltaE: number;
}
export type ChromaDeviceMessage = ChromaScanMessage | ChromaCompareMessage;
export type ChromaDeviceCommand = { command: 'scan' } |
  { command: 'mode'; mode: 'scan' | 'compare' | 'convert' | 'image-match' } |
  { command: 'image-match-result'; rgb: DeviceColourData['rgb']; deltaE00: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Firmware IMR is one compact UTF-8 write, without the legacy JSON/LF framing. */
export function encodeImageMatchResultCommand(rgb: DeviceColourData['rgb'], deltaE00: number): Uint8Array {
  if (!record(rgb) || !(['r', 'g', 'b'] as const).every(key => numberIn(rgb[key], 0, 255) && Number.isInteger(rgb[key])) ||
    !numberIn(deltaE00, 0, Infinity) || deltaE00 >= 1e21) throw new Error('Invalid Image Match result.');
  const bytes = new TextEncoder().encode(`IMR,${rgb.r},${rgb.g},${rgb.b},${deltaE00.toFixed(1)}`);
  if (bytes.length > 20) throw new Error('Image Match result exceeds the 20-byte BLE command limit.');
  return bytes;
}

export function isDeviceColourData(value: unknown): value is DeviceColourData {
  if (!record(value) || !record(value.rgb) || typeof value.hex !== 'string' || !/^#[\da-f]{6}$/i.test(value.hex)) return false;
  const rgb = value.rgb;
  if (!['r', 'g', 'b'].every(key => numberIn(rgb[key], 0, 255) && Number.isInteger(rgb[key]))) return false;
  // Reject contradictory representations instead of displaying the wrong swatch.
  const hex = '#' + ['r', 'g', 'b'].map(key => (rgb[key] as number).toString(16).padStart(2, '0')).join('');
  if (hex.toUpperCase() !== value.hex.toUpperCase()) return false;
  if (value.hsl !== undefined && (!record(value.hsl) || !numberIn(value.hsl.h, 0, 360) ||
    !numberIn(value.hsl.s, 0, 100) || !numberIn(value.hsl.l, 0, 100))) return false;
  if (value.lab !== undefined && (!record(value.lab) || !numberIn(value.lab.l, 0, 100) ||
    !numberIn(value.lab.a, -Infinity, Infinity) || !numberIn(value.lab.b, -Infinity, Infinity))) return false;
  if (value.cmyk !== undefined && (!record(value.cmyk) ||
    !['c', 'm', 'y', 'k'].every(key => numberIn((value.cmyk as Record<string, unknown>)[key], 0, 100)))) return false;
  return value.clear === undefined || numberIn(value.clear, 0, Infinity);
}

export function isChromaDeviceMessage(value: unknown): value is ChromaDeviceMessage {
  if (!record(value)) return false;
  if (value.type === 'scan') return isDeviceColourData(value);
  return value.type === 'compare' && isDeviceColourData(value.reference) && isDeviceColourData(value.sample) &&
    numberIn(value.deltaE, 0, Infinity);
}
