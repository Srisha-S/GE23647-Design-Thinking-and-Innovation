import { Capacitor } from '@capacitor/core';
import type { LightingMode, MaterialType } from './materialProfiles';

export interface VisualizeMetadata {
  product: 'CHROMA';
  kind: 'visualize';
  version: 1;
  targetColor: string;
  targetHex: string;
  targetRgb: { r: number; g: number; b: number };
  targetLab: { l: number; a: number; b: number };
  colourSource: 'Latest Scan' | 'Library';
  libraryItemId?: string;
  libraryItemName?: string;
  capturedAt?: string;
  readingSource?: string;
  intensity: number;
  intensityUnit?: 'percent';
  imageName: string;
  naturalWidth: number;
  naturalHeight: number;
  outputWidth: number;
  outputHeight: number;
  createdAt: string;
  material?: MaterialType;
  materialLabel?: string;
  lighting?: LightingMode;
  lightingKelvin?: number;
  lightShiftModel?: 'lab-cast-approximation';
  selectionMethod?: 'manual' | 'local-region' | 'sam3';
  selectionRefined?: boolean;
  renderer?: 'lab-material-v2';
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function metadataChunk(metadata: VisualizeMetadata): Uint8Array {
  // Uncompressed UTF-8 iTXt: keyword, compression flag/method, language and translated keyword.
  const data = encoder.encode(`CHROMA\0\0\0\0\0${JSON.stringify(metadata)}`);
  const chunk = new Uint8Array(data.length + 12);
  new DataView(chunk.buffer).setUint32(0, data.length);
  chunk.set(encoder.encode('iTXt'), 4);
  chunk.set(data, 8);
  new DataView(chunk.buffer).setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}

/** The exported PNG itself retains the colour/source metadata, including when shared as one file. */
export function attachPngMetadata(png: Uint8Array, metadata: VisualizeMetadata): Uint8Array<ArrayBuffer> {
  if (!PNG_SIGNATURE.every((value, index) => png[index] === value)) throw new Error('Preview export requires a PNG image.');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = PNG_SIGNATURE.length;
  let endOffset = -1;
  let hasHeader = false;
  const keep: Uint8Array[] = [png.subarray(0, PNG_SIGNATURE.length)];
  while (offset + 12 <= png.length) {
    const size = view.getUint32(offset);
    const end = offset + 12 + size;
    if (end > png.length) throw new Error('The PNG preview is incomplete.');
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (offset === PNG_SIGNATURE.length) {
      hasHeader = type === 'IHDR' && size === 13;
      if (!hasHeader) throw new Error('The PNG preview has no valid image header.');
    }
    if (type === 'IEND') {
      if (size !== 0 || end !== png.length) throw new Error('The PNG preview is incomplete.');
      endOffset = offset;
      break;
    }
    const isChromaMetadata = (type === 'iTXt' || type === 'tEXt') && size >= 7
      && String.fromCharCode(...png.subarray(offset + 8, offset + 15)) === 'CHROMA\0';
    if (!isChromaMetadata) keep.push(png.subarray(offset, end));
    offset = end;
  }
  if (!hasHeader || endOffset < 0) throw new Error('The PNG preview is incomplete.');
  keep.push(metadataChunk(metadata), png.subarray(endOffset));
  const result = new Uint8Array(keep.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of keep) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

export interface PreviewExportDependencies {
  isNative(): boolean;
  writeCacheFile(filename: string, base64: string, signal?: AbortSignal): Promise<{ uri: string }>;
  deleteCacheFile(filename: string): Promise<void>;
  nativeShare(uri: string, signal?: AbortSignal): Promise<void>;
  makeFile(blob: Blob, filename: string): File;
  canShareFiles(files: File[]): boolean;
  shareFiles(files: File[], signal?: AbortSignal): Promise<void>;
  download(blob: Blob, filename: string, signal?: AbortSignal): void | Promise<void>;
  now(): Date;
}

const defaults: PreviewExportDependencies = {
  isNative: () => Capacitor.isNativePlatform(),
  async writeCacheFile(path, data, signal) {
    checkCancelled(signal);
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    checkCancelled(signal);
    // Omit Encoding: the Filesystem plugin interprets this string as binary base64.
    return Filesystem.writeFile({ path, data, directory: Directory.Cache });
  },
  async deleteCacheFile(path) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.deleteFile({ path, directory: Directory.Cache });
  },
  async nativeShare(uri, signal) {
    checkCancelled(signal);
    const { Share } = await import('@capacitor/share');
    checkCancelled(signal);
    await Share.share({ title: 'CHROMA colour preview', files: [uri], dialogTitle: 'Save or share your colour preview' });
  },
  makeFile: (blob, filename) => new File([blob], filename, { type: 'image/png' }),
  canShareFiles: files => typeof navigator.canShare === 'function' && navigator.canShare({ files }),
  async shareFiles(files, signal) { checkCancelled(signal); await navigator.share({ title: 'CHROMA colour preview', files }); },
  download(blob, filename, signal) {
    checkCancelled(signal);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
      link.href = url;
      link.download = filename;
      document.body.append(link);
      checkCancelled(signal); link.click();
    } finally {
      link.remove();
      // Allow the browser to begin consuming the resource before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
  now: () => new Date(),
};

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(parts.join(''));
}

function wasCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const details = error as { name?: string; message?: string };
  return details.name === 'AbortError' || /\bcancel(?:led|ed|lation)?\b/i.test(details.message || '');
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Preview export was cancelled.', 'AbortError');
}

// Only completed share-sheet files become eligible for deletion on the next export.
const finishedNativeFiles = new Map<PreviewExportDependencies['writeCacheFile'], Set<string>>();
let exportNumber = 0;

export async function exportPreview(
  imageBlob: Blob,
  metadata: VisualizeMetadata,
  mode: 'save' | 'share',
  overrides: Partial<PreviewExportDependencies> = {},
  signal?: AbortSignal,
): Promise<string> {
  const dependencies = { ...defaults, ...overrides };
  try {
    checkCancelled(signal);
    const bytes = await imageBlob.arrayBuffer();
    checkCancelled(signal);
    const png = attachPngMetadata(new Uint8Array(bytes), metadata);
    const filename = `chroma-visualize-${dependencies.now().toISOString().replace(/[:.]/g, '-')}-${++exportNumber}.png`;
    checkCancelled(signal);
    if (dependencies.isNative()) {
      const oldFiles = finishedNativeFiles.get(dependencies.writeCacheFile) || new Set<string>();
      finishedNativeFiles.set(dependencies.writeCacheFile, oldFiles);
      await Promise.all([...oldFiles].map(async path => {
        try { await dependencies.deleteCacheFile(path); oldFiles.delete(path); } catch { /* Retry cleanup on the next export. */ }
      }));
      checkCancelled(signal);
      try {
        const data = toBase64(png);
        checkCancelled(signal);
        const { uri } = await dependencies.writeCacheFile(filename, data, signal);
        checkCancelled(signal);
        await dependencies.nativeShare(uri, signal);
        checkCancelled(signal);
      } finally {
        if (signal?.aborted) {
          // The pending write/share has settled before cleanup. Never delete a
          // different export's file or an in-progress share-sheet resource.
          try { await dependencies.deleteCacheFile(filename); }
          catch { oldFiles.add(filename); /* Retry this generated cache file later. */ }
        } else oldFiles.add(filename);
      }
      return 'Preview ready. Choose where to save or share it in the share menu.';
    }
    const blob = new Blob([png], { type: 'image/png' });
    if (mode === 'share') {
      const file = dependencies.makeFile(blob, filename);
      let canShare = false;
      try { canShare = dependencies.canShareFiles([file]); } catch { /* Use the existing download fallback. */ }
      checkCancelled(signal);
      if (canShare) {
        try {
          checkCancelled(signal);
          await dependencies.shareFiles([file], signal);
          checkCancelled(signal);
          return 'Preview shared.';
        } catch (error) {
          // Rendering a large preview may outlast Web Share's transient user activation.
          // Unsupported/policy-restricted sharing can still save the fully rendered PNG.
          const name = error && typeof error === 'object' ? (error as { name?: string }).name : '';
          if (!['NotAllowedError', 'NotSupportedError', 'SecurityError'].includes(name || '')) throw error;
          checkCancelled(signal);
          await dependencies.download(blob, filename, signal);
          checkCancelled(signal);
          return 'The share menu is unavailable here. Your PNG preview was downloaded.';
        }
      }
    }
    checkCancelled(signal);
    await dependencies.download(blob, filename, signal);
    checkCancelled(signal);
    return mode === 'share' ? 'File sharing is unavailable here. Your PNG preview was downloaded.' : 'PNG preview saved with its colour metadata.';
  } catch (error) {
    if (wasCancelled(error)) return 'Sharing cancelled.';
    throw error;
  }
}
