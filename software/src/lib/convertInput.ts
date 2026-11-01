import { parseColor } from './color';
import type { ColourFormat } from '../types';

/** Convert uses full six-digit HEX; other CHROMA tools keep shorthand support. */
export function parseConvertInput(input: string, format: ColourFormat): string {
  if (format === 'HEX' && (typeof input !== 'string' || !/^#?[\da-f]{6}$/i.test(input.trim()))) {
    throw new Error('Enter exactly 6 hexadecimal digits, with or without #.');
  }
  // The shared parser validates channel counts, numeric syntax and ranges and
  // performs every conversion, including the existing HSL / LAB / CMYK inputs.
  return parseColor(input, format);
}
