import { hexToRgb, labToRgb, rgbToLab, type LAB } from '../../lib/color';
import { featherMask, validateDimensions, validateMask, type MaskData } from './mask';
import { lightingPreset, materialProfile, type LightingMode, type LightingPreset, type MaterialProfile, type MaterialType } from './materialProfiles';

export { LIGHTING_PRESETS, MATERIAL_PROFILES } from './materialProfiles';
export type { LightingMode, MaterialType } from './materialProfiles';

export interface ImagePixels { width: number; height: number; data: Uint8ClampedArray }
export interface RecolourOptions {
  signal?: AbortSignal;
  yieldEveryRows?: number;
  material?: MaterialType;
  lighting?: LightingMode;
  /** Optional measured D65 LAB target. Retained directly rather than round-tripping through HEX. */
  targetLab?: LAB;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
interface SurfaceStatistics { l: number; a: number; b: number; weight: number }

function validateImage(image: ImagePixels): void {
  validateDimensions(image.width, image.height);
  if (!(image.data instanceof Uint8ClampedArray) || image.data.length !== image.width * image.height * 4) throw new RangeError('Image data must contain RGBA bytes for every pixel.');
}

function prepare(source: ImagePixels, mask: MaskData, targetHex: string, options: RecolourOptions) {
  validateImage(source);
  validateMask(mask);
  if (source.width !== mask.width || source.height !== mask.height) throw new RangeError('Image and mask dimensions must match.');
  const fromHex = rgbToLab(hexToRgb(targetHex));
  let target = fromHex;
  if (options.targetLab !== undefined) {
    const lab = options.targetLab;
    if (!lab || ![lab.l, lab.a, lab.b].every(Number.isFinite) || lab.l < 0 || lab.l > 100 || lab.a < -128 || lab.a > 127 || lab.b < -128 || lab.b > 127) {
      throw new RangeError('Target LAB must contain finite L* from 0 to 100 and a*/b* from -128 to 127.');
    }
    target = { l: lab.l, a: lab.a, b: lab.b };
  }
  return { target, profile: materialProfile(options.material), lighting: lightingPreset(options.lighting), selection: featherMask(mask, 1), output: { width: source.width, height: source.height, data: source.data.slice() } };
}

function surfaceSum(source: ImagePixels, mask: MaskData, start: number, end: number): SurfaceStatistics {
  let l = 0, a = 0, b = 0, weight = 0;
  for (let p = start; p < end; p++) {
    const i = p * 4, amount = mask.data[p] / 255 * source.data[i + 3] / 255;
    if (!amount) continue;
    const lab = rgbToLab({ r: source.data[i], g: source.data[i + 1], b: source.data[i + 2] });
    l += lab.l * amount; a += lab.a * amount; b += lab.b * amount;
    weight += amount;
  }
  return { l, a, b, weight };
}

/** Preserve local L* structure around a new material midtone, with black/white endpoints. */
function adaptLightness(lightness: number, mean: number, target: number): number {
  const anchor = Math.max(5, Math.min(95, target));
  const pivot = Math.max(1, Math.min(99, mean));
  return lightness <= pivot ? lightness / pivot * anchor : anchor + (lightness - pivot) / (100 - pivot) * (100 - anchor);
}

/** A tiny selected-neighbour shading estimate; never samples an unrelated surface. */
function localLightness(source: ImagePixels, mask: MaskData, p: number, original: number): number {
  const x = p % source.width, y = Math.floor(p / source.width);
  let sum = original, weight = 1;
  const add = (index: number) => {
    const i = index * 4, amount = mask.data[index] / 255 * source.data[i + 3] / 255;
    if (!amount) return;
    sum += rgbToLab({ r: source.data[i], g: source.data[i + 1], b: source.data[i + 2] }).l * amount;
    weight += amount;
  };
  if (x) add(p - 1);
  if (x + 1 < source.width) add(p + 1);
  if (y) add(p - source.width);
  if (y + 1 < source.height) add(p + source.width);
  return sum / weight;
}

function transformRange(source: ImagePixels, mask: MaskData, output: ImagePixels, target: LAB, mean: LAB, profile: MaterialProfile, lighting: LightingPreset, start: number, end: number): void {
  const anchor = Math.max(5, Math.min(95, target.l));
  for (let p = start; p < end; p++) {
    const i = p * 4, amount = mask.data[p] / 255;
    if (!amount || !source.data[i + 3]) continue;
    const original = rgbToLab({ r: source.data[i], g: source.data[i + 1], b: source.data[i + 2] });
    let l = adaptLightness(original.l, mean.l, target.l);
    if (profile.textureStrength !== 1) {
      const shading = localLightness(source, mask, p, original.l);
      // Separate the existing coarse shading from fine detail, then restore the
      // detail with a modest material-specific gain. No pixels are blurred.
      const detail = original.l - shading;
      const pivot = clamp(mean.l, 1, 99);
      const slope = original.l <= pivot ? anchor / pivot : (100 - anchor) / (100 - pivot);
      l = clamp(l + detail * slope * (profile.textureStrength - 1), 0, 100);
    }
    l += (original.l - l) * profile.originalLightnessRetention;
    // Neutral bright reflections keep their original light and lose most target chroma.
    const specular = clamp((original.l - profile.specularStart) / (100 - profile.specularStart), 0, 1) * Math.max(0, 1 - Math.hypot(original.a, original.b) / profile.specularNeutrality);
    // Never darken an already brightened highlight; doing so would invert a white target's lighting ramp.
    const outputL = clamp(l + Math.max(0, original.l - l) * specular, 0, 100);
    const shadowChroma = Math.min(1, outputL / Math.max(1, anchor));
    const highlightChroma = Math.min(1, Math.sqrt(Math.max(0, (100 - outputL) / Math.max(1, 100 - anchor))));
    const chroma = shadowChroma * highlightChroma * (1 - specular * profile.specularRetention);
    // Retain deviations from the old mean, not the old material's base colour.
    // Wood keeps coloured grain; metal keeps more existing reflection colour.
    const detailRetention = profile.chromaDetailRetention * shadowChroma * highlightChroma;
    // LightShift is an illustrative LAB cast inside the selected surface only.
    // It does not claim spectral relighting or modify the saved target colour.
    const lightAmount = Math.sqrt(clamp(outputL / 100, 0, 1)) * Math.sqrt(clamp((100 - outputL) / 20, 0, 1));
    const replacement = labToRgb({
      l: outputL,
      a: clamp(target.a * chroma + (original.a - mean.a) * detailRetention + lighting.aShift * lightAmount, -128, 127),
      b: clamp(target.b * chroma + (original.b - mean.b) * detailRetention + lighting.bShift * lightAmount, -128, 127),
    });
    output.data[i] = source.data[i] + (replacement.r - source.data[i]) * amount;
    output.data[i + 1] = source.data[i + 1] + (replacement.g - source.data[i + 1]) * amount;
    output.data[i + 2] = source.data[i + 2] + (replacement.b - source.data[i + 2]) * amount;
    // Alpha remains byte-for-byte identical, including partially transparent PNGs.
  }
}

/** No RGB colour overlay: LAB chroma replacement with a monotonic lighting curve. */
export function buildRecolour(source: ImagePixels, mask: MaskData, targetHex: string, options: RecolourOptions = {}): ImagePixels {
  const { target, profile, lighting, selection, output } = prepare(source, mask, targetHex, options);
  const sum = surfaceSum(source, selection, 0, selection.data.length);
  if (sum.weight) transformRange(source, selection, output, target, { l: sum.l / sum.weight, a: sum.a / sum.weight, b: sum.b / sum.weight }, profile, lighting, 0, selection.data.length);
  return output;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Recolour rendering was cancelled.', 'AbortError');
}

/** Chunked final rendering yields to the UI and can be cancelled when a photo changes. */
export async function buildRecolourAsync(source: ImagePixels, mask: MaskData, targetHex: string, options: RecolourOptions = {}): Promise<ImagePixels> {
  checkCancelled(options.signal);
  const { target, profile, lighting, selection, output } = prepare(source, mask, targetHex, options);
  const rows = Number.isFinite(options.yieldEveryRows) ? Math.max(1, Math.min(128, Math.round(options.yieldEveryRows!))) : 16;
  const chunk = source.width * rows;
  const sum: SurfaceStatistics = { l: 0, a: 0, b: 0, weight: 0 };
  for (let start = 0; start < selection.data.length; start += chunk) {
    checkCancelled(options.signal);
    const subtotal = surfaceSum(source, selection, start, Math.min(selection.data.length, start + chunk));
    sum.l += subtotal.l; sum.a += subtotal.a; sum.b += subtotal.b; sum.weight += subtotal.weight;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (sum.weight) {
    for (let start = 0; start < selection.data.length; start += chunk) {
      checkCancelled(options.signal);
      transformRange(source, selection, output, target, { l: sum.l / sum.weight, a: sum.a / sum.weight, b: sum.b / sum.weight }, profile, lighting, start, Math.min(selection.data.length, start + chunk));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  checkCancelled(options.signal);
  return output;
}

/** Cheap cached-result blending; this does not run the LAB transform again. */
export function blendIntensity(source: ImagePixels, transformed: ImagePixels, intensity0to100: number): ImagePixels {
  validateImage(source); validateImage(transformed);
  if (source.width !== transformed.width || source.height !== transformed.height) throw new RangeError('Preview dimensions must match.');
  if (!Number.isFinite(intensity0to100) || intensity0to100 < 0 || intensity0to100 > 100) throw new RangeError('Colour intensity must be from 0 to 100.');
  const output: ImagePixels = { width: source.width, height: source.height, data: source.data.slice() };
  const amount = intensity0to100 / 100;
  if (!amount) return output;
  for (let i = 0; i < source.data.length; i += 4) {
    output.data[i] = source.data[i] + (transformed.data[i] - source.data[i]) * amount;
    output.data[i + 1] = source.data[i + 1] + (transformed.data[i + 1] - source.data[i + 1]) * amount;
    output.data[i + 2] = source.data[i + 2] + (transformed.data[i + 2] - source.data[i + 2]) * amount;
  }
  return output;
}
