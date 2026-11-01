import type { ImagePixels } from './imageUtils';
import type { MaskData, Point } from './mask';
import { DEFAULT_SAM3_SERVER, selectSam3Surface } from './segmentationClient';
import { selectLocalSurface } from './surfaceSelection';
import { selectCloudSam3Surface, type CloudSelectionProgress } from './cloudSam3Client';

export type SelectionEngine = 'cloud' | 'local' | 'sam3';
export interface SegmentationConfiguration {
  defaultEngine: SelectionEngine;
  space: string;
  localServerUrl: string;
  development: boolean;
}
export interface SelectionOptions {
  signal?: AbortSignal;
  tolerance?: number;
  onProgress?: (progress: CloudSelectionProgress) => void;
}
export interface SegmentationProvider {
  id: 'cloud-sam3' | 'local-sam3' | 'local-region';
  selectionMethod: 'sam3' | 'local-region';
  select(image: ImagePixels, point: Point, options: SelectionOptions): Promise<MaskData>;
}
export function resolveSegmentationConfiguration(env: Record<string, unknown>, development: boolean): SegmentationConfiguration {
  const configured = env.VITE_CHROMA_SAM_PROVIDER;
  // Shipping builds always start with cloud Auto Select, including unconfigured builds.
  const defaultEngine: SelectionEngine = !development ? 'cloud'
    : configured === 'cloud' ? 'cloud' : configured === 'local-sam3' ? 'sam3' : 'local';
  return {
    defaultEngine, development,
    space: typeof env.VITE_CHROMA_SAM_SPACE === 'string' ? env.VITE_CHROMA_SAM_SPACE.trim() : '',
    localServerUrl: !development ? '' : typeof env.VITE_CHROMA_SAM3_URL === 'string' ? env.VITE_CHROMA_SAM3_URL : DEFAULT_SAM3_SERVER,
  };
}
export const segmentationConfiguration = resolveSegmentationConfiguration({
  VITE_CHROMA_SAM_PROVIDER: import.meta.env?.VITE_CHROMA_SAM_PROVIDER,
  VITE_CHROMA_SAM_SPACE: import.meta.env?.VITE_CHROMA_SAM_SPACE,
  VITE_CHROMA_SAM3_URL: import.meta.env?.VITE_CHROMA_SAM3_URL,
}, import.meta.env?.DEV === true);

/** Automatic providers return masks only. Manual editing and recolouring keep their existing ownership. */
export function createSegmentationProvider(engine: SelectionEngine, config: SegmentationConfiguration): SegmentationProvider {
  if (engine === 'cloud') return {
    id: 'cloud-sam3', selectionMethod: 'sam3',
    select: (image, point, options) => selectCloudSam3Surface(image, point, { space: config.space, signal: options.signal, onProgress: options.onProgress }),
  };
  if (engine === 'sam3') return {
    id: 'local-sam3', selectionMethod: 'sam3',
    select: (image, point, options) => selectSam3Surface(image, point, { serverUrl: config.localServerUrl, signal: options.signal }),
  };
  return {
    id: 'local-region', selectionMethod: 'local-region',
    select: (image, point, options) => selectLocalSurface(image, point, { tolerance: options.tolerance, signal: options.signal }),
  };
}
