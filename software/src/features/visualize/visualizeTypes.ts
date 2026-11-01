import type { ColourRecord } from '../../types';
import { colorInfo } from '../../lib/color';
import type { VisualizeMetadata } from './exportPreview';
import { lightingPreset, materialProfile, type LightingMode, type MaterialType } from './materialProfiles';

export type VisualizeColourSource = 'Latest Scan' | 'Library';
export interface VisualizeTarget {
  colour: ColourRecord;
  colourSource: VisualizeColourSource;
  libraryItemId?: string;
  libraryItemName?: string;
}

/** Snapshot an existing CHROMA record; incoming scans must not change an applied target. */
export function snapshotTarget(colour: ColourRecord, colourSource: VisualizeColourSource): VisualizeTarget {
  const info = colorInfo(colour.hex);
  return {
    colour: { ...colour, hex: info.hex, rgb: { ...info.rgb }, tags: [...colour.tags] },
    colourSource,
    ...(colourSource === 'Library' ? { libraryItemId: colour.id, libraryItemName: colour.name } : {}),
  };
}

export function hasLatestScan(colour: ColourRecord): boolean {
  return ['bluetooth', 'usb', 'wifi', 'demo'].includes(colour.source);
}

export interface VisualizeAppearance {
  material: MaterialType;
  lighting: LightingMode;
  selectionMethod: 'manual' | 'local-region' | 'sam3';
  selectionRefined?: boolean;
}

export function previewMetadata(target: VisualizeTarget, image: { name: string; naturalWidth: number; naturalHeight: number }, intensity: number, output: { width: number; height: number }, appearance?: VisualizeAppearance): VisualizeMetadata {
  const info = colorInfo(target.colour.hex);
  return {
    product: 'CHROMA', kind: 'visualize', version: 1,
    targetColor: target.colour.name || info.name, targetHex: info.hex,
    targetRgb: { ...info.rgb }, targetLab: { ...info.lab },
    colourSource: target.colourSource,
    ...(target.libraryItemId ? { libraryItemId: target.libraryItemId, libraryItemName: target.libraryItemName } : {}),
    capturedAt: target.colour.createdAt, readingSource: target.colour.source,
    intensity, intensityUnit: 'percent', imageName: image.name, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
    outputWidth: output.width, outputHeight: output.height, createdAt: new Date().toISOString(),
    ...(appearance ? {
      material: appearance.material, materialLabel: materialProfile(appearance.material).label,
      lighting: appearance.lighting, lightingKelvin: lightingPreset(appearance.lighting).kelvin,
      lightShiftModel: 'lab-cast-approximation' as const,
      selectionMethod: appearance.selectionMethod, selectionRefined: Boolean(appearance.selectionRefined),
      renderer: 'lab-material-v2' as const,
    } : {}),
  };
}
