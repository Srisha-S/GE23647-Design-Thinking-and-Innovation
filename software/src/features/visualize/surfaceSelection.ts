import { rgbToLab } from '../../lib/color';
import type { ImagePixels } from './imageUtils';
import { createMask, validateDimensions, type MaskData, type Point } from './mask';

export interface SurfaceSelectionOptions {
  /** LAB colour tolerance from 1 to 80. This is local region selection, not object recognition. */
  tolerance?: number;
  /** Maximum neighbour colour edge distance; luminance is weighted to allow smooth shading. */
  edgeThreshold?: number;
  signal?: AbortSignal;
}

export function throwIfSelectionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Selection was cancelled.', 'AbortError');
}

export function validateSelectionImage(image: ImagePixels): void {
  validateDimensions(image.width, image.height);
  if (!(image.data instanceof Uint8ClampedArray) || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Selection requires complete RGBA pixels from the working photo.');
  }
}

export function validateSelectionPoint(point: Point, width: number, height: number): void {
  if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
    throw new RangeError('Tap within the photo to select an area.');
  }
}

/**
 * Four-connected colour region with a seed colour limit and a local edge barrier.
 * Smooth changes in brightness remain selectable; isolated regions and strong colour
 * boundaries do not join merely because their colours resemble the seed. This is
 * intentionally labelled local region selection rather than AI object segmentation.
 * The source pixels are read-only, and no mask is published until selection completes.
 */
export async function selectLocalSurface(image: ImagePixels, point: Point, options: SurfaceSelectionOptions = {}): Promise<MaskData> {
  validateSelectionImage(image);
  validateSelectionPoint(point, image.width, image.height);
  throwIfSelectionAborted(options.signal);
  const tolerance = options.tolerance ?? 28;
  const edgeThreshold = options.edgeThreshold ?? Math.min(45, tolerance * .55 + 10);
  if (!Number.isFinite(tolerance) || tolerance < 1 || tolerance > 80
    || !Number.isFinite(edgeThreshold) || edgeThreshold < 1 || edgeThreshold > 100) {
    throw new RangeError('Selection tolerance must be 1–80 and edge threshold 1–100.');
  }
  const { width, height, data } = image;
  const count = width * height;
  const seed = Math.floor(point.y) * width + Math.floor(point.x);
  if (data[seed * 4 + 3] < 16) throw new Error('Tap a visible part of the photo to select an area.');
  const mask = createMask(width, height);
  const states = new Uint8Array(count);
  const queue = new Uint32Array(count);
  const labs = new Float32Array(count * 3);
  const labReady = new Uint8Array(count);
  function readLab(index: number): number {
    const position = index * 3;
    if (!labReady[index]) {
      const pixel = index * 4;
      const lab = rgbToLab({ r: data[pixel], g: data[pixel + 1], b: data[pixel + 2] });
      labs[position] = lab.l; labs[position + 1] = lab.a; labs[position + 2] = lab.b;
      labReady[index] = 1;
    }
    return position;
  }
  const seedLab = readLab(seed);
  const toleranceSquared = tolerance * tolerance;
  const edgeSquared = edgeThreshold * edgeThreshold;
  let read = 0, write = 1;
  queue[0] = seed; states[seed] = 1; mask.data[seed] = 255;
  function consider(index: number, fromLab: number): void {
    if (states[index]) return;
    if (data[index * 4 + 3] < 16) { states[index] = 2; return; }
    const candidate = readLab(index);
    const dl = (labs[candidate] - labs[seedLab]) * .28;
    const da = labs[candidate + 1] - labs[seedLab + 1];
    const db = labs[candidate + 2] - labs[seedLab + 2];
    if (dl * dl + da * da + db * db > toleranceSquared) { states[index] = 2; return; }
    const edgeL = (labs[candidate] - labs[fromLab]) * .7;
    const edgeA = labs[candidate + 1] - labs[fromLab + 1];
    const edgeB = labs[candidate + 2] - labs[fromLab + 2];
    if (edgeL * edgeL + edgeA * edgeA + edgeB * edgeB > edgeSquared) return;
    states[index] = 1; mask.data[index] = 255; queue[write++] = index;
  }
  while (read < write) {
    const index = queue[read++];
    const x = index % width, y = Math.floor(index / width);
    const current = readLab(index);
    if (x) consider(index - 1, current);
    if (x + 1 < width) consider(index + 1, current);
    if (y) consider(index - width, current);
    if (y + 1 < height) consider(index + width, current);
    if (read % 8192 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      throwIfSelectionAborted(options.signal);
    }
  }
  throwIfSelectionAborted(options.signal);
  return mask;
}
