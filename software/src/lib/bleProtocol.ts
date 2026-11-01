import { colorInfo, rgbToHex } from './color';
import type { ChromaReferenceMessage, ChromaScanMessage, DeviceColourData } from '../types/deviceProtocol';

export type BlePacket = ChromaScanMessage | ChromaReferenceMessage |
  { type: 'sample'; sample: DeviceColourData; deltaE: number };

/** v1: one complete comma-separated packet per notification (optional CR/LF).
 * Without framing a truncated final number is indistinguishable from a complete
 * number. Firmware must notify whole packets, not unframed partial messages.
 */
export function parseBlePacket(text: string): BlePacket | null {
  if (text.length > 128) return null;
  const fields = text.trim().split(',').map(field => field.trim());
  const [kind, ...values] = fields;
  if (!['SCAN', 'REF', 'CMP'].includes(kind) || fields.length !== (kind === 'REF' ? 4 : 5)) return null;
  if (!values.slice(0, 3).every(value => /^\d{1,3}$/.test(value) && Number(value) <= 255)) return null;
  const [r, g, b] = values.slice(0, 3).map(Number);
  const { hex, rgb, hsl, lab, cmyk } = colorInfo(rgbToHex(r, g, b));
  const colour = { hex, rgb, hsl, lab, cmyk };
  if (kind === 'REF') return { type: 'reference', ...colour };
  const last = values[3];
  if (kind === 'SCAN') {
    if (!/^\d+$/.test(last) || !Number.isSafeInteger(Number(last))) return null;
    return { type: 'scan', ...colour, clear: Number(last) };
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(last) || !Number.isFinite(Number(last))) return null;
  return { type: 'sample', sample: colour, deltaE: Number(last) };
}
