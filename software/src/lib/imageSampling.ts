import type { RGB } from '../types';

export interface ImageSize { width: number; height: number }
export interface ImagePoint { x: number; y: number }
export interface DisplayBounds extends ImageSize { left: number; top: number }
export interface SampleBounds extends ImagePoint, ImageSize {}

function validSize(size: ImageSize) {
  return Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0;
}

/** Client coordinates and DOM bounds both use CSS pixels, regardless of devicePixelRatio.
 * The image is centred with contain sizing; taps in any letterbox are ignored. */
export function displayToImagePixel(point: ImagePoint, bounds: DisplayBounds, image: ImageSize): ImagePoint | null {
  if (!validSize(image) || ![point.x, point.y, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  const scale = Math.min(bounds.width / image.width, bounds.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  const left = bounds.left + (bounds.width - width) / 2, top = bounds.top + (bounds.height - height) / 2;
  const x = point.x - left, y = point.y - top;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x: Math.min(image.width - 1, Math.floor(x / scale)), y: Math.min(image.height - 1, Math.floor(y / scale)) };
}

/** A 3 × 3 neighbourhood, reduced at the edges so no pixels are duplicated. */
export function imageSampleBounds(point: ImagePoint, image: ImageSize): SampleBounds | null {
  if (!validSize(image) || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) return null;
  const x = Math.max(0, point.x - 1), y = Math.max(0, point.y - 1);
  return { x, y, width: Math.min(image.width - 1, point.x + 1) - x + 1, height: Math.min(image.height - 1, point.y + 1) - y + 1 };
}

/** Average the original RGBA samples after compositing each pixel over white. */
export function averageImagePixels(pixels: ArrayLike<number>): RGB | null {
  if (!pixels.length || pixels.length % 4 !== 0) return null;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (![pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]].every(value => Number.isFinite(value) && value >= 0 && value <= 255)) return null;
    const alpha = pixels[i + 3] / 255;
    r += pixels[i] * alpha + 255 * (1 - alpha);
    g += pixels[i + 1] * alpha + 255 * (1 - alpha);
    b += pixels[i + 2] * alpha + 255 * (1 - alpha);
  }
  const count = pixels.length / 4;
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}
