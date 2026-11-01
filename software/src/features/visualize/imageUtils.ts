/** Loading and manual/local editing stay on-device; optional SAM 3 sends working pixels only on an explicit tap. */
export interface ImagePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface WorkingImage {
  name: string;
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
  pixels: ImagePixels;
  element: HTMLImageElement;
  url: string;
  dispose(): void;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_NATURAL_PIXELS = 40_000_000;
const WORKING_EDGE = 1200;
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
}

function fitDimensions(width: number, height: number, longestEdge: number, maxPixels: number) {
  if (!validDimensions(width, height)) throw new Error('The photo has invalid dimensions.');
  const ratio = Math.min(1, longestEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
}

/** Export from the original image, independent of its on-screen/working size. */
export function getExportDimensions(naturalWidth: number, naturalHeight: number) {
  return fitDimensions(naturalWidth, naturalHeight, 4096, 8_000_000);
}

/** The canvas itself uses the image aspect ratio, so no contain/letterbox offset is needed. */
export function displayToImagePoint(
  clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  width: number, height: number,
): { x: number; y: number } | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || !validDimensions(width, height)) return null;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  return { x: Math.min(width - 1, x * width / rect.width), y: Math.min(height - 1, y * height / rect.height) };
}

function signatureType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Validate accepted formats before allocating an image/canvas. */
export async function validateVisualizeImageFile(file: File): Promise<void> {
  if (file.size === 0) throw new Error('This photo is empty. Choose a JPEG, PNG or WEBP image.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose a photo smaller than 20 MB.');
  if (file.type && !MIME_TYPES.has(file.type.toLowerCase())) throw new Error('Choose a JPEG, PNG or WEBP image.');
  const actualType = signatureType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!actualType || (file.type && file.type.toLowerCase() !== actualType)) {
    throw new Error('This file is not a valid JPEG, PNG or WEBP image.');
  }
}

/** Keep the original decoder for a later full-size export; only the working pixels are retained. */
export async function loadVisualizeImage(file: File): Promise<WorkingImage> {
  await validateVisualizeImageFile(file);
  const url = URL.createObjectURL(file);
  const element = new Image();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    element.onload = null;
    element.onerror = null;
    element.src = '';
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () => reject(new Error('This photo could not be decoded. Try a different JPEG, PNG or WEBP image.'));
      element.src = url;
    });
    element.onload = null;
    element.onerror = null;
    const naturalWidth = element.naturalWidth;
    const naturalHeight = element.naturalHeight;
    if (!validDimensions(naturalWidth, naturalHeight) || naturalWidth * naturalHeight > MAX_NATURAL_PIXELS) {
      throw new Error('Choose a photo of 40 megapixels or less.');
    }
    const { width, height } = fitDimensions(naturalWidth, naturalHeight, WORKING_EDGE, WORKING_EDGE * WORKING_EDGE);
    const pixels = renderOriginalPixels({ element }, width, height);
    return { name: file.name, naturalWidth, naturalHeight, width, height, pixels, element, url, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Temporary canvas is released immediately after copying pixels. */
export function renderOriginalPixels(image: Pick<WorkingImage, 'element'>, width: number, height: number): ImagePixels {
  if (!validDimensions(width, height) || width * height > 8_000_000) throw new Error('The requested image output is too large.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image processing is unavailable in this browser.');
    context.drawImage(image.element, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    return { width, height, data: pixels.data };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
