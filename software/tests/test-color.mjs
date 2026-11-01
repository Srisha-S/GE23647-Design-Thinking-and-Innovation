// Run: node --experimental-default-type=module tests/test-color.mjs
// Also browser-compatible: import('/tests/test-color.mjs').
import { normalizeHex, hexToRgb, rgbToHex, rgbToLab, labToRgb, rgbToCmyk, cmykToRgb, rgbToHsl, hslToRgb, ciede2000, deltaE, contrastRatio, parseColor, colorInfo, generatePalette } from '../color.js';

let assertions = 0;
function assert(condition, message) {
  assertions++;
  if (!condition) throw new Error(message);
}
function close(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected}`);
}
function rejects(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

assert(normalizeHex(' #abc ') === '#AABBCC', 'Short HEX expansion');
assert(normalizeHex('c76b4a') === '#C76B4A', 'Canonical HEX');
['', '#abcd', 'red', '#12QQ34', '1234567', '##123456'].forEach(value => rejects(() => normalizeHex(value), `Reject invalid HEX ${value}`));
assert(rgbToHex(199, 107, 74) === '#C76B4A', 'RGB to HEX');
assert(JSON.stringify(hexToRgb('#C76B4A')) === JSON.stringify({ r: 199, g: 107, b: 74 }), 'HEX to RGB');
const red = rgbToLab({ r: 255, g: 0, b: 0 });
close(red.l, 53.2408, 0.0001, 'D65 red L*');
close(red.a, 80.0925, 0.0001, 'D65 red a*');
close(red.b, 67.2032, 0.0001, 'D65 red b*');
close(rgbToLab({ r: 255, g: 255, b: 255 }).l, 100, 0.0001, 'D65 white');
close(rgbToLab({ r: 0, g: 0, b: 0 }).l, 0, 0.0001, 'D65 black');

// Sharma, Wu & Dalal (2005), table 1 pairs 1–16, including hue discontinuities.
// https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
const references = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.0200, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0000],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0000],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0000],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0010, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
  [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
  [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0010, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
];
references.forEach(([l, a, b, l2, a2, b2, expected], index) => {
  const first = { l, a, b }, second = { l: l2, a: a2, b: b2 };
  close(ciede2000(first, second), expected, 0.00005, `CIEDE2000 reference ${index + 1}`);
  close(ciede2000(first, second), ciede2000(second, first), 1e-10, `CIEDE2000 symmetry ${index + 1}`);
});

for (const r of [0, 32, 128, 199, 255]) {
  for (const g of [0, 64, 128, 220, 255]) {
    for (const b of [0, 74, 128, 192, 255]) {
      const rgb = { r, g, b }, hex = rgbToHex(r, g, b);
      for (const roundTrip of [labToRgb(rgbToLab(rgb)), cmykToRgb(rgbToCmyk(rgb)), hslToRgb(rgbToHsl(rgb))]) {
        assert(rgbToHex(roundTrip.r, roundTrip.g, roundTrip.b) === hex, `RGB round trip for ${hex}`);
      }
      close(deltaE(hex, hex), 0, 1e-12, `Identical colours ${hex}`);
    }
  }
}

close(contrastRatio('#000000', '#FFFFFF'), 21, 1e-12, 'Black-white WCAG contrast');
close(contrastRatio('#C76B4A', '#C76B4A'), 1, 1e-12, 'Identical contrast');
assert(parseColor('rgb(199, 107, 74)', 'RGB') === '#C76B4A', 'Wrapped RGB');
assert(parseColor('199 107 74', 'RGB') === '#C76B4A', 'Space-separated RGB');
assert(parseColor('0%,100%,100%,0%', 'CMYK') === '#FF0000', 'CMYK percentages');
assert(parseColor('53.2408,80.0925,67.2032', 'LAB') === '#FF0000', 'LAB conversion');
assert(parseColor('120,100%,50%', 'HSL') === '#00FF00', 'HSL conversion');
[
  ['256,0,0', 'RGB'], ['-1,0,0', 'RGB'], ['1,,2', 'RGB'], ['1,2,3,4', 'RGB'],
  ['1,2,no', 'RGB'], ['1,2,3garbage', 'RGB'], ['rgb(1,2,3)', 'LAB'], ['101,0,0', 'LAB'],
  ['50,128,0', 'LAB'], ['0,0,0,101', 'CMYK'], ['', 'RGB'], ['10%,20%,30%', 'RGB'],
].forEach(([value, format]) => rejects(() => parseColor(value, format), `Invalid ${format}: ${value}`));
for (const scheme of ['analogous', 'complementary', 'monochromatic', 'triadic', 'split-complementary']) {
  const palette = generatePalette('#C76B4A', scheme);
  assert(palette.length === 5 && palette.every(value => /^#[0-9A-F]{6}$/.test(value)), `Five valid ${scheme} colours`);
  assert(palette[2] === '#C76B4A', `Base retained in ${scheme}`);
}
assert(colorInfo('#C76B4A').name === 'Terracotta', 'Exact curated colour name');
assert(colorInfo('#000').textColor === '#FFFFFF', 'Light text on black');
assert(colorInfo('#FFF').textColor === '#171717', 'Dark text on white');

// Production ScanPage crash: derived saturation overflowed on valid saved RGB/HEX.
for (const hex of ['#000075', '#000001', '#000009', '#000013', '#010000', '#000100', '#FFFEFF', '#FEFFFF', '#FFFFFE', '#000000', '#FFFFFF']) {
  const hsl = colorInfo(hex).hsl;
  assert(Number.isFinite(hsl.h) && hsl.h >= 0 && hsl.h < 360, `Finite wrapped generated hue for ${hex}`);
  assert(Number.isFinite(hsl.s) && hsl.s >= 0 && hsl.s <= 100 && Number.isFinite(hsl.l) && hsl.l >= 0 && hsl.l <= 100, `Generated percentages stay in the strict HSL domain for ${hex}`);
  for (const scheme of ['analogous', 'complementary', 'monochromatic', 'triadic', 'split-complementary']) {
    const palette = generatePalette(hex, scheme);
    assert(palette.length === 5 && palette[2] === hex && palette.every(value => /^#[0-9A-F]{6}$/.test(value)), `Saved ${hex} renders the complete ${scheme} palette`);
  }
}
// Cover every 8-bit RGB boundary face, where maximum saturation and cancellation occur.
let boundarySamples = 0;
for (let first = 0; first <= 255; first++) {
  for (let second = 0; second <= 255; second++) {
    for (const rgb of [{ r: 0, g: first, b: second }, { r: 255, g: first, b: second }, { r: first, g: 0, b: second }, { r: first, g: 255, b: second }, { r: first, g: second, b: 0 }, { r: first, g: second, b: 255 }]) {
      const hsl = rgbToHsl(rgb);
      if (![hsl.h, hsl.s, hsl.l].every(Number.isFinite) || hsl.h < 0 || hsl.h >= 360 || hsl.s < 0 || hsl.s > 100 || hsl.l < 0 || hsl.l > 100) throw new Error(`Out-of-range derived HSL for ${JSON.stringify(rgb)}`);
      const roundTrip = hslToRgb(hsl);
      if (roundTrip.r !== rgb.r || roundTrip.g !== rgb.g || roundTrip.b !== rgb.b) throw new Error(`HSL boundary round trip failed for ${JSON.stringify(rgb)}`);
      boundarySamples++;
    }
  }
}
assert(boundarySamples === 393216, 'All 393,216 RGB boundary samples produce valid HSL and exact 8-bit round trips');
for (const s of [undefined, null, NaN, Infinity, '45%', '45', -1, 100.00001, 101]) {
  rejects(() => hslToRgb({ h: 30, s, l: 50 }), `Strict conversion still rejects invalid raw saturation ${String(s)}`);
}
rejects(() => parseColor('30,101%,50%', 'HSL'), 'Manual Convert validation still rejects out-of-range saturation');
export const testResult = `${assertions} colour assertions passed; 16 published CIEDE2000 reference pairs verified.`;
console.log(testResult);
