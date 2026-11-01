import { colorInfo, hslToRgb, normalizeHex, rgbToHex } from './color';
import type { ColourInfo, HSL } from './color';

export interface PersistedColourDiagnostic {
  context: string;
  id?: string;
  name?: string;
  source: 'hex' | 'rgb' | 'hsl' | 'unrecoverable';
  reasons: string[];
  hsl?: Partial<HSL>;
}
type DiagnosticReporter = (diagnostic: PersistedColourDiagnostic) => void;
const recentDiagnostics: PersistedColourDiagnostic[] = [];
export function recentColourDiagnostics(): PersistedColourDiagnostic[] {
  return recentDiagnostics.map(value => ({ ...value, reasons: [...value.reasons], ...(value.hsl ? { hsl: { ...value.hsl } } : {}) }));
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';

function numeric(value: unknown, unit = ''): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 64) return null;
  const pattern = new RegExp(`^(${numberPattern})\\s*${unit ? `(?:${unit})?` : ''}$`, 'i');
  const match = value.trim().match(pattern);
  if (!match) return null;
  const result = Number(match[1]);
  return Number.isFinite(result) ? result : null;
}

function legacyHsl(value: unknown): { parsed: HSL | null; finite: Partial<HSL> } {
  let components = record(value);
  if (typeof value === 'string' && value.length <= 240) {
    const text = value.trim().replace(/^hsl\(\s*(.*?)\s*\)$/i, '$1');
    const parts = text.includes(',') ? text.split(/\s*,\s*/) : text.split(/\s+/);
    components = parts.length === 3 ? { h: parts[0], s: parts[1], l: parts[2] } : {};
  }
  const h = numeric(components.h, 'deg'), s = numeric(components.s, '%'), l = numeric(components.l, '%');
  const finite = { ...(h !== null ? { h } : {}), ...(s !== null ? { s } : {}), ...(l !== null ? { l } : {}) };
  return { parsed: h !== null && s !== null && l !== null ? { h, s, l } : null, finite };
}

/** Compatibility belongs at the saved-data boundary; manual colour validators stay strict. */
export function normalisePersistedColour(
  value: unknown,
  context = 'saved colour',
  report: DiagnosticReporter = diagnostic => console.warn(`[CHROMA colour recovery] ${JSON.stringify(diagnostic)}`),
): ColourInfo | null {
  const item = record(value);
  const reasons: string[] = [];
  const hslValue = item.hsl !== undefined ? item.hsl
    : ['h', 's', 'l'].some(key => key in item) ? item
      : typeof value === 'string' && /^hsl\(/i.test(value.trim()) ? value : undefined;
  const savedHsl = hslValue === undefined ? undefined : legacyHsl(hslValue);
  if (savedHsl && (!savedHsl.parsed || savedHsl.parsed.h < 0 || savedHsl.parsed.h > 360 || savedHsl.parsed.s < 0 || savedHsl.parsed.s > 100 || savedHsl.parsed.l < 0 || savedHsl.parsed.l > 100)) {
    reasons.push('invalid-stored-hsl');
  }
  function diagnose(source: PersistedColourDiagnostic['source']) {
    if (!reasons.length) return;
    const id = label(item.id, 80), name = label(item.name, 80);
    // Never include a full record, raw strings, tags, notes, or non-finite numbers.
    const diagnostic = { context: label(context, 100), ...(id ? { id } : {}), ...(name ? { name } : {}), source, reasons: [...reasons], ...(savedHsl && Object.keys(savedHsl.finite).length ? { hsl: savedHsl.finite } : {}) };
    recentDiagnostics.push(diagnostic);
    if (recentDiagnostics.length > 5) recentDiagnostics.shift();
    try { report(diagnostic); }
    catch { /* Diagnostics must not prevent recovery. */ }
  }
  let hex: string | undefined;
  let source: PersistedColourDiagnostic['source'] = 'unrecoverable';
  const hexValue = typeof value === 'string' && hslValue === undefined ? value : item.hex;
  if (hexValue !== undefined && hexValue !== null && hexValue !== '') {
    try { hex = normalizeHex(hexValue as string); source = 'hex'; }
    catch { reasons.push('invalid-stored-hex'); }
  }
  if (!hex) {
    const rgbValue = item.rgb !== undefined ? item.rgb : ['r', 'g', 'b'].some(key => key in item) ? item : undefined;
    if (rgbValue !== undefined) {
      const rgb = record(rgbValue);
      const channels = [numeric(rgb.r), numeric(rgb.g), numeric(rgb.b)];
      if (channels.every((channel): channel is number => channel !== null && Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
        hex = rgbToHex(channels[0], channels[1], channels[2]);
        source = 'rgb';
        reasons.push('recovered-from-rgb');
      } else reasons.push('invalid-stored-rgb');
    }
  }
  if (!hex && savedHsl?.parsed) {
    const { h, s, l } = savedHsl.parsed;
    // Old storage accepted finite out-of-range HSL values. Repair only that legacy representation.
    const normalized = { h: ((h % 360) + 360) % 360, s: Math.max(0, Math.min(100, s)), l: Math.max(0, Math.min(100, l)) };
    const rgb = hslToRgb(normalized);
    hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    source = 'hsl';
    reasons.push('recovered-from-hsl');
    if (h !== normalized.h || s !== normalized.s || l !== normalized.l) reasons.push('repaired-legacy-hsl-range');
  }
  if (!hex) {
    reasons.push('quarantined-original-retained');
    diagnose('unrecoverable');
    return null;
  }
  // Every derived value is recomputed from the selected canonical colour.
  const info = colorInfo(hex);
  diagnose(source);
  return info;
}
