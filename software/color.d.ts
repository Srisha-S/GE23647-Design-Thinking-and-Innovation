export interface RGB { r: number; g: number; b: number }
export interface LAB { l: number; a: number; b: number }
export interface HSL { h: number; s: number; l: number }
export interface CMYK { c: number; m: number; y: number; k: number }
export interface ColourInfo { hex: string; rgb: RGB; lab: LAB; hsl: HSL; cmyk: CMYK; name: string; textColor: string }
export function normalizeHex(input: string): string;
export function hexToRgb(hex: string): RGB;
export function rgbToHex(r: number, g: number, b: number): string;
export function rgbToLab(rgb: RGB): LAB;
export function labToRgb(lab: LAB): RGB;
export function rgbToCmyk(rgb: RGB): CMYK;
export function cmykToRgb(cmyk: CMYK): RGB;
export function rgbToHsl(rgb: RGB): HSL;
export function hslToRgb(hsl: HSL): RGB;
export function ciede2000(a: LAB, b: LAB): number;
export function deltaE(a: string, b: string): number;
export function nearestName(hex: string): string;
export function colorInfo(hex: string): ColourInfo;
export function parseColor(input: string, format?: string): string;
export function generatePalette(base: string, scheme?: string): string[];
export function contrastRatio(a: string, b: string): number;
