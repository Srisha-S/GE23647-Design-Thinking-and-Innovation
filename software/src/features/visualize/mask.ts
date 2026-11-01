/** A mask has one alpha byte per image pixel, independent of display size. */
export interface MaskData { width: number; height: number; data: Uint8ClampedArray }
export interface Point { x: number; y: number }
export type BrushMode = 'brush' | 'eraser';

const MAX_PIXELS = 40_000_000;

export function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new RangeError('Image dimensions must be positive integers with at most 40 million pixels.');
  }
}

export function validateMask(mask: MaskData): void {
  validateDimensions(mask.width, mask.height);
  if (!(mask.data instanceof Uint8ClampedArray) || mask.data.length !== mask.width * mask.height) {
    throw new RangeError('Mask data must contain one alpha byte per image pixel.');
  }
}

export function createMask(width: number, height: number): MaskData {
  validateDimensions(width, height);
  return { width, height, data: new Uint8ClampedArray(width * height) };
}

export function cloneMask(mask: MaskData): MaskData {
  validateMask(mask);
  return { width: mask.width, height: mask.height, data: mask.data.slice() };
}

/** Rasterize a continuous capsule rather than stamping isolated circles. */
export function paintStroke(mask: MaskData, from: Point, to: Point, radius: number, mode: BrushMode): void {
  validateMask(mask);
  if (![from.x, from.y, to.x, to.y, radius].every(Number.isFinite) || radius <= 0 || (mode !== 'brush' && mode !== 'eraser')) return;
  const edgeRadius = Math.min(radius, Math.max(mask.width, mask.height) * 2) + .5;
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - edgeRadius));
  const right = Math.min(mask.width - 1, Math.ceil(Math.max(from.x, to.x) + edgeRadius));
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - edgeRadius));
  const bottom = Math.min(mask.height - 1, Math.ceil(Math.max(from.y, to.y) + edgeRadius));
  const dx = to.x - from.x, dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSquared)) return;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const t = lengthSquared ? Math.max(0, Math.min(1, ((x + .5 - from.x) * dx + (y + .5 - from.y) * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(x + .5 - from.x - t * dx, y + .5 - from.y - t * dy);
      const alpha = Math.round(Math.max(0, Math.min(1, edgeRadius - distance)) * 255);
      const index = y * mask.width + x;
      mask.data[index] = mode === 'brush' ? Math.max(mask.data[index], alpha) : Math.min(mask.data[index], 255 - alpha);
    }
  }
}

/** Small inward-only box feather: never invent selection outside the input mask. */
export function featherMask(mask: MaskData, radius = 1): MaskData {
  validateMask(mask);
  if (!Number.isFinite(radius) || radius < 0 || radius > 32) throw new RangeError('Feather radius must be from 0 to 32 pixels.');
  const r = Math.round(radius);
  const result = cloneMask(mask);
  if (!r) return result;
  const horizontal = new Float32Array(mask.data.length);
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width;
    let sum = 0;
    for (let x = 0; x <= Math.min(mask.width - 1, r); x++) sum += mask.data[row + x];
    for (let x = 0; x < mask.width; x++) {
      const count = Math.min(mask.width - 1, x + r) - Math.max(0, x - r) + 1;
      horizontal[row + x] = sum / count;
      if (x - r >= 0) sum -= mask.data[row + x - r];
      if (x + r + 1 < mask.width) sum += mask.data[row + x + r + 1];
    }
  }
  for (let x = 0; x < mask.width; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(mask.height - 1, r); y++) sum += horizontal[y * mask.width + x];
    for (let y = 0; y < mask.height; y++) {
      const index = y * mask.width + x;
      const count = Math.min(mask.height - 1, y + r) - Math.max(0, y - r) + 1;
      result.data[index] = Math.min(mask.data[index], Math.round(sum / count));
      if (y - r >= 0) sum -= horizontal[(y - r) * mask.width + x];
      if (y + r + 1 < mask.height) sum += horizontal[(y + r + 1) * mask.width + x];
    }
  }
  return result;
}

/** Pixel-centred bilinear interpolation is used only for alpha, never image texture. */
export function resizeMask(mask: MaskData, width: number, height: number): MaskData {
  validateMask(mask);
  const result = createMask(width, height);
  if (width === mask.width && height === mask.height) return cloneMask(mask);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(mask.height - 1, (y + .5) * mask.height / height - .5));
    const y0 = Math.floor(sy), y1 = Math.min(mask.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(mask.width - 1, (x + .5) * mask.width / width - .5));
      const x0 = Math.floor(sx), x1 = Math.min(mask.width - 1, x0 + 1), fx = sx - x0;
      const top = mask.data[y0 * mask.width + x0] * (1 - fx) + mask.data[y0 * mask.width + x1] * fx;
      const bottom = mask.data[y1 * mask.width + x0] * (1 - fx) + mask.data[y1 * mask.width + x1] * fx;
      result.data[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return result;
}
