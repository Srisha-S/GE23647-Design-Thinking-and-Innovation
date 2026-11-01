import { colorInfo, normalizeHex } from './color';
import type { DeviceReading, MatchTarget, MatchTargetMetadata } from '../types';

/** Session-only matching workflow. File pixels stay in the Image page, never storage. */
export interface ImageMatchState { target: MatchTarget | null; sample: DeviceReading | null }
export const emptyImageMatch: ImageMatchState = { target: null, sample: null };
export type ImageMatchAction = { type: 'target'; hex: string | null; metadata?: MatchTargetMetadata } |
  { type: 'reading' | 'sample'; reading: DeviceReading | null };

/** Optional source snapshots extend v2 backups without depending on a live Library item. */
export function normaliseMatchTargetMetadata(value: unknown): MatchTargetMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.source !== 'image' && input.source !== 'library') return undefined;
  const result: MatchTargetMetadata = { source: input.source };
  const fields = input.source === 'library' ? ['name', 'libraryItemId', 'libraryProjectId'] as const : ['name', 'imageName'] as const;
  for (const field of fields) {
    if (typeof input[field] === 'string') {
      const text = input[field].trim().slice(0, field === 'name' ? 80 : field === 'imageName' ? 255 : 100);
      if (text) result[field] = text;
    }
  }
  return result;
}

export function remapMatchTargetMetadata(value: unknown, libraryIds: ReadonlyMap<string, string>, projectIds: ReadonlyMap<string, string>): MatchTargetMetadata | undefined {
  const metadata = normaliseMatchTargetMetadata(value);
  if (metadata?.source !== 'library') return metadata;
  if (metadata.libraryItemId) metadata.libraryItemId = libraryIds.get(metadata.libraryItemId) ?? metadata.libraryItemId;
  if (metadata.libraryProjectId) metadata.libraryProjectId = projectIds.get(metadata.libraryProjectId) ?? metadata.libraryProjectId;
  return metadata;
}

export function reduceImageMatch(state: ImageMatchState, action: ImageMatchAction): ImageMatchState {
  if (action.type === 'target') {
    if (action.hex === null) return { ...state, target: null };
    const metadata = normaliseMatchTargetMetadata(action.metadata ?? { source: 'image' });
    if (!metadata) return state;
    try {
      const { hex, rgb } = colorInfo(action.hex);
      return { ...state, target: { ...metadata, hex, rgb } };
    }
    catch { return state; }
  }
  if (!action.reading) return action.type === 'sample' ? { ...state, sample: null } : state;
  const reading = action.reading;
  if (action.type === 'reading' && !['bluetooth', 'usb', 'wifi', 'demo'].includes(reading.source)) return state;
  if (typeof reading.source !== 'string' || !reading.source.trim() || typeof reading.timestamp !== 'string' || !Number.isFinite(Date.parse(reading.timestamp))) return state;
  try {
    return { ...state, sample: { ...reading, hex: normalizeHex(reading.hex) } };
  } catch { return state; }
}
