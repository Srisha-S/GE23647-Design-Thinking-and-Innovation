/* CHROMA colour utilities. sRGB, D65 / 2° observer. No external dependencies.
 * CMYK is a mathematical approximation; print output depends on the ICC profile.
 * CIEDE2000 reference: Sharma, Wu & Dalal (2005), doi:10.1002/col.20070.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rad = degrees => degrees * Math.PI / 180;
const deg = radians => radians * 180 / Math.PI;
const wrap = hue => (hue % 360 + 360) % 360;

function component(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function validateRgb({ r, g, b }) {
  return { r: component(r, 'Red', 0, 255), g: component(g, 'Green', 0, 255), b: component(b, 'Blue', 0, 255) };
}

export function normalizeHex(input) {
  if (typeof input !== 'string') throw new Error('Enter a HEX colour, such as #C76B4A.');
  let value = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) value = [...value].map(char => char + char).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error('Enter 3 or 6 hexadecimal digits, such as #C76B4A.');
  return `#${value.toUpperCase()}`;
}

export function hexToRgb(hex) {
  const value = normalizeHex(hex).slice(1);
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}

export function rgbToHex(r, g, b) {
  const rgb = validateRgb({ r, g, b });
  return '#' + [rgb.r, rgb.g, rgb.b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function linearRgb(rgb) {
  const { r, g, b } = validateRgb(rgb);
  return [r, g, b].map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}

export function rgbToLab(rgb) {
  const [r, g, b] = linearRgb(rgb);
  const xyz = [
    (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883,
  ];
  const [x, y, z] = xyz.map(value => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116);
  return { l: clamp(116 * y - 16, 0, 100), a: 500 * (x - y), b: 200 * (y - z) };
}

// LAB colours outside the sRGB gamut are clipped to the nearest RGB channel boundary.
export function labToRgb({ l, a, b }) {
  component(l, 'L*', 0, 100);
  component(a, 'a*', -128, 127);
  component(b, 'b*', -128, 127);
  const fy = (l + 16) / 116;
  const inverse = value => value ** 3 > 216 / 24389 ? value ** 3 : (116 * value - 16) / (24389 / 27);
  const x = inverse(fy + a / 500) * 0.95047;
  const y = inverse(fy);
  const z = inverse(fy - b / 200) * 1.08883;
  const values = [
    x * 3.2404542 - y * 1.5371385 - z * 0.4985314,
    -x * 0.9692660 + y * 1.8760108 + z * 0.0415560,
    x * 0.0556434 - y * 0.2040259 + z * 1.0572252,
  ].map(value => Math.round(clamp(value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055, 0, 1) * 255));
  return { r: values[0], g: values[1], b: values[2] };
}

export function rgbToCmyk(rgb) {
  const { r, g, b } = validateRgb(rgb);
  const k = 1 - Math.max(r, g, b) / 255;
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: (1 - r / 255 - k) / (1 - k) * 100, m: (1 - g / 255 - k) / (1 - k) * 100, y: (1 - b / 255 - k) / (1 - k) * 100, k: k * 100 };
}

export function cmykToRgb({ c, m, y, k }) {
  [c, m, y, k].forEach((value, index) => component(value, ['Cyan', 'Magenta', 'Yellow', 'Black'][index], 0, 100));
  const values = [c, m, y].map(value => Math.round(255 * (1 - value / 100) * (1 - k / 100)));
  return { r: values[0], g: values[1], b: values[2] };
}

export function rgbToHsl(rgb) {
  const validated = validateRgb(rgb);
  const [r, g, b] = [validated.r, validated.g, validated.b].map(value => value / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: clamp(l * 100, 0, 100) };
  const h = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  // Avoid subtracting nearly equal numbers for dark/light saturated colours.
  // The old denominator made valid #000001 produce s=100.00000000000036,
  // which our strict hslToRgb validator correctly rejected during palette rendering.
  const denominator = l <= 0.5 ? max + min : 2 - max - min;
  return { h: wrap(h * 60), s: clamp(delta / denominator * 100, 0, 100), l: clamp(l * 100, 0, 100) };
}

export function hslToRgb({ h, s, l }) {
  component(h, 'Hue', 0, 360);
  component(s, 'Saturation', 0, 100);
  component(l, 'Lightness', 0, 100);
  const chroma = (1 - Math.abs(2 * l / 100 - 1)) * s / 100;
  const x = chroma * (1 - Math.abs((wrap(h) / 60) % 2 - 1));
  const m = l / 100 - chroma / 2;
  const sections = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  const values = sections[Math.floor(wrap(h) / 60)].map(value => Math.round((value + m) * 255));
  return { r: values[0], g: values[1], b: values[2] };
}

/** CIEDE2000, parametric factors kL = kC = kH = 1. */
export function ciede2000(first, second) {
  for (const lab of [first, second]) {
    if (!lab || ![lab.l, lab.a, lab.b].every(Number.isFinite)) throw new Error('Two finite LAB colours are required.');
  }
  const c1 = Math.hypot(first.a, first.b), c2 = Math.hypot(second.a, second.b);
  const meanC = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const a1 = (1 + g) * first.a, a2 = (1 + g) * second.a;
  const cp1 = Math.hypot(a1, first.b), cp2 = Math.hypot(a2, second.b);
  const hp1 = cp1 === 0 ? 0 : wrap(deg(Math.atan2(first.b, a1)));
  const hp2 = cp2 === 0 ? 0 : wrap(deg(Math.atan2(second.b, a2)));
  const dl = second.l - first.l, dc = cp2 - cp1;
  let dh = hp2 - hp1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(rad(dh / 2));
  const meanL = (first.l + second.l) / 2, meanCp = (cp1 + cp2) / 2;
  let meanH;
  if (cp1 * cp2 === 0) meanH = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) meanH = (hp1 + hp2) / 2;
  else meanH = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  const t = 1 - 0.17 * Math.cos(rad(meanH - 30)) + 0.24 * Math.cos(rad(2 * meanH)) + 0.32 * Math.cos(rad(3 * meanH + 6)) - 0.20 * Math.cos(rad(4 * meanH - 63));
  const sl = 1 + 0.015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCp, sh = 1 + 0.015 * meanCp * t;
  const rt = -2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7)) * Math.sin(rad(60 * Math.exp(-(((meanH - 275) / 25) ** 2))));
  const lTerm = dl / sl, cTerm = dc / sc, hTerm = dH / sh;
  return Math.sqrt(Math.max(0, lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm));
}

export function deltaE(hexA, hexB) {
  return ciede2000(rgbToLab(hexToRgb(hexA)), rgbToLab(hexToRgb(hexB)));
}

function luminance(hex) {
  const [r, g, b] = linearRgb(hexToRgb(hex));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(hexA, hexB) {
  const first = luminance(hexA), second = luminance(hexB);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

// Descriptive nearest names are creative labels, not standardised colour names.
const NAMED_COLOURS = [
  ['Ink', '#171717'], ['Charcoal', '#34363A'], ['Slate', '#667385'], ['Mist', '#DDE1E5'], ['Cloud', '#F5F4F0'], ['Paper', '#FFFFFF'],
  ['Oat', '#DCCBB4'], ['Sand', '#D6B990'], ['Warm Taupe', '#A48C7B'], ['Cocoa', '#785848'], ['Espresso', '#45352F'], ['Terracotta', '#C76B4A'],
  ['Burnt Sienna', '#B9563E'], ['Rust', '#A54932'], ['Peach', '#F5BDA2'], ['Apricot', '#F8AB76'], ['Coral', '#F47767'], ['Papaya', '#F78D53'],
  ['Dusty Rose', '#D4808E'], ['Rosewater', '#F4C9D1'], ['Rose', '#E3658E'], ['Raspberry', '#BE3862'], ['Cherry', '#DA3D4C'], ['Brick', '#A14443'],
  ['Burgundy', '#702D44'], ['Blush', '#E8B4B8'], ['Mauve', '#B88AA5'], ['Orchid', '#BF80CF'], ['Lilac', '#C5AFE2'], ['Lavender', '#B9B2E4'],
  ['Periwinkle', '#949EE5'], ['Iris', '#7A72D4'], ['Violet', '#8658CD'], ['Plum', '#694273'], ['Cobalt', '#3768D1'], ['Cornflower', '#729DE4'],
  ['Sky', '#A1D2F0'], ['Cerulean', '#288CBF'], ['Ocean', '#246B8E'], ['Navy', '#263650'], ['Teal', '#398A8B'], ['Sea Glass', '#9CCBC0'],
  ['Mint', '#B6DFCE'], ['Sage', '#A0B49A'], ['Eucalyptus', '#6E9B85'], ['Forest', '#39604B'], ['Olive', '#8D965C'], ['Pistachio', '#C8D5A3'],
  ['Lime', '#C3D95B'], ['Lemon', '#F4DF74'], ['Butter', '#F4E5B8'], ['Marigold', '#EDB342'], ['Honey', '#CD9C4D'], ['Amber', '#D98F38'],
].map(([name, hex]) => ({ name, hex, lab: rgbToLab(hexToRgb(hex)) }));

export function nearestName(hex) {
  const lab = rgbToLab(hexToRgb(hex));
  let closest = NAMED_COLOURS[0], distance = Infinity;
  for (const colour of NAMED_COLOURS) {
    const difference = ciede2000(lab, colour.lab);
    if (difference < distance) { distance = difference; closest = colour; }
  }
  return closest.name;
}

export function colorInfo(input) {
  const hex = normalizeHex(input), rgb = hexToRgb(hex);
  return { hex, rgb, lab: rgbToLab(rgb), cmyk: rgbToCmyk(rgb), hsl: rgbToHsl(rgb), name: nearestName(hex), textColor: contrastRatio(hex, '#FFFFFF') > contrastRatio(hex, '#171717') ? '#FFFFFF' : '#171717' };
}

export function parseColor(input, format = 'HEX') {
  const kind = String(format).trim().toUpperCase();
  if (kind === 'HEX') return normalizeHex(input);
  if (!['RGB', 'LAB', 'CMYK', 'HSL'].includes(kind)) throw new Error('Choose HEX, RGB, LAB, CMYK, or HSL.');
  if (typeof input !== 'string') throw new Error(`Enter ${kind} values separated by commas.`);
  let value = input.trim();
  const wrapper = value.match(/^([a-z]+)\s*\((.*)\)$/i);
  if (wrapper) {
    if (wrapper[1].toUpperCase() !== kind) throw new Error(`Enter ${kind} values or change the input format.`);
    value = wrapper[2].trim();
  }
  const tokens = value.includes(',') ? value.split(',').map(item => item.trim()) : value.split(/\s+/);
  const expected = kind === 'CMYK' ? 4 : 3;
  if (tokens.length !== expected || !tokens.every(item => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(item))) {
    throw new Error(`Enter exactly ${expected} ${kind} values separated by commas.`);
  }
  if (tokens.some(item => item.endsWith('%')) && kind !== 'CMYK' && kind !== 'HSL') throw new Error(`${kind} values must be numbers without a percent sign.`);
  if (kind === 'HSL' && tokens[0].endsWith('%')) throw new Error('HSL hue is in degrees, not percent.');
  const values = tokens.map(item => Number(item.replace('%', '')));
  let rgb;
  if (kind === 'RGB') rgb = validateRgb({ r: values[0], g: values[1], b: values[2] });
  if (kind === 'LAB') rgb = labToRgb({ l: values[0], a: values[1], b: values[2] });
  if (kind === 'CMYK') rgb = cmykToRgb({ c: values[0], m: values[1], y: values[2], k: values[3] });
  if (kind === 'HSL') rgb = hslToRgb({ h: values[0], s: values[1], l: values[2] });
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

export function generatePalette(baseHex, scheme = 'analogous') {
  const hex = normalizeHex(baseHex), { h, s, l } = rgbToHsl(hexToRgb(hex));
  const schemes = {
    analogous: [[-40, 4], [-20, 12], [0, 0], [20, -8], [40, 6]],
    complementary: [[0, -18], [0, 15], [0, 0], [180, 0], [180, 18]],
    monochromatic: [[0, -25], [0, -12], [0, 0], [0, 14], [0, 28]],
    triadic: [[120, -12], [120, 12], [0, 0], [240, -4], [240, 15]],
    'split-complementary': [[0, 15], [150, 0], [0, 0], [210, 0], [210, 18]],
  };
  const selected = schemes[String(scheme).toLowerCase()];
  if (!selected) throw new Error('Choose analogous, complementary, monochromatic, triadic, or split-complementary.');
  return selected.map(([hueOffset, lightnessOffset], index) => {
    if (index === 2) return hex;
    const rgb = hslToRgb({ h: wrap(h + hueOffset), s, l: clamp(l + lightnessOffset, 8, 94) });
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  });
}
