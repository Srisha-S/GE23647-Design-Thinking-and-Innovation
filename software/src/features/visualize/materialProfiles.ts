/** Photographic appearance presets, not measured BRDFs or a spectral renderer. */
export type MaterialType = 'fabric' | 'paint' | 'wood' | 'plastic' | 'metal' | 'ceramic';
export type LightingMode = 'daylight' | 'neutral' | 'warm' | 'cool';

export interface MaterialProfile {
  readonly id: MaterialType;
  readonly label: string;
  readonly description: string;
  /** Gain applied to existing fine luminance detail. No texture is generated. */
  readonly textureStrength: number;
  readonly originalLightnessRetention: number;
  readonly chromaDetailRetention: number;
  readonly specularStart: number;
  readonly specularNeutrality: number;
  readonly specularRetention: number;
}

export const MATERIAL_PROFILES: readonly MaterialProfile[] = Object.freeze([
  { id: 'fabric', label: 'Fabric', description: 'Folds, weave and soft highlights', textureStrength: 1, originalLightnessRetention: 0, chromaDetailRetention: 0, specularStart: 82, specularNeutrality: 18, specularRetention: .95 },
  { id: 'paint', label: 'Paint / Wall', description: 'Matte shading and surface bumps', textureStrength: .9, originalLightnessRetention: 0, chromaDetailRetention: 0, specularStart: 94, specularNeutrality: 18, specularRetention: .4 },
  { id: 'wood', label: 'Wood', description: 'Existing grain, knots and shading', textureStrength: 1.12, originalLightnessRetention: .04, chromaDetailRetention: .28, specularStart: 86, specularNeutrality: 24, specularRetention: .7 },
  { id: 'plastic', label: 'Plastic', description: 'Smooth contours and bright highlights', textureStrength: 1, originalLightnessRetention: .02, chromaDetailRetention: .04, specularStart: 73, specularNeutrality: 30, specularRetention: .98 },
  { id: 'metal', label: 'Metal', description: 'Existing reflections and specular detail', textureStrength: 1.06, originalLightnessRetention: .24, chromaDetailRetention: .4, specularStart: 58, specularNeutrality: 50, specularRetention: .995 },
  { id: 'ceramic', label: 'Ceramic', description: 'Glazed highlights and surface contours', textureStrength: .96, originalLightnessRetention: .03, chromaDetailRetention: .06, specularStart: 76, specularNeutrality: 32, specularRetention: .98 },
].map(profile => Object.freeze(profile)) as MaterialProfile[]);

export interface LightingPreset {
  readonly id: LightingMode;
  readonly label: string;
  /** Indicative UI label only; the image effect is a bounded LAB colour cast. */
  readonly kelvin: number;
  readonly description: string;
  readonly aShift: number;
  readonly bShift: number;
}

export const LIGHTING_PRESETS: readonly LightingPreset[] = Object.freeze([
  { id: 'daylight', label: 'Daylight', kelvin: 6500, description: 'Original D65 colour preview', aShift: 0, bShift: 0 },
  { id: 'neutral', label: 'Neutral', kelvin: 4000, description: 'Subtle warm indoor approximation', aShift: 1.2, bShift: 4 },
  { id: 'warm', label: 'Warm', kelvin: 2700, description: 'Warm indoor approximation', aShift: 4, bShift: 14 },
  { id: 'cool', label: 'Cool', kelvin: 8000, description: 'Cool light approximation', aShift: -.8, bShift: -8 },
].map(preset => Object.freeze(preset)) as LightingPreset[]);

export function materialProfile(id: MaterialType = 'fabric'): MaterialProfile {
  const profile = MATERIAL_PROFILES.find(item => item.id === id);
  if (!profile) throw new RangeError('Choose a supported Visualize material.');
  return profile;
}

export function lightingPreset(id: LightingMode = 'daylight'): LightingPreset {
  const preset = LIGHTING_PRESETS.find(item => item.id === id);
  if (!preset) throw new RangeError('Choose a supported LightShift preset.');
  return preset;
}
