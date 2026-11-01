export interface PaletteColour { hex: string; proportion: number }

type Cluster = { r: number; g: number; b: number; count: number };
const distance = (a: Cluster, b: Cluster) => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
const hex = (colour: Cluster) => '#' + [colour.r, colour.g, colour.b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Deterministic, weighted k-means over 5-bit RGB bins. Transparent pixels are
 * ignored; partially transparent pixels are composited on the preview's white.
 * Fewer than `count` distinct colours produce fewer results, never fake colours.
 */
export function extractDominantColours(pixels: ArrayLike<number>, count = 5): PaletteColour[] {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Choose between 1 and 12 palette colours.');
  if (pixels.length % 4 !== 0) throw new Error('Expected RGBA pixel data.');
  const bins = new Map<number, Cluster>();
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha === 0) continue;
    const r = Math.round(pixels[i] * alpha + 255 * (1 - alpha));
    const g = Math.round(pixels[i + 1] * alpha + 255 * (1 - alpha));
    const b = Math.round(pixels[i + 2] * alpha + 255 * (1 - alpha));
    const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
    const bin = bins.get(key);
    if (bin) { bin.r += r; bin.g += g; bin.b += b; bin.count++; }
    else bins.set(key, { r, g, b, count: 1 });
    total++;
  }
  const colours = [...bins.values()].map(bin => ({ r: bin.r / bin.count, g: bin.g / bin.count, b: bin.b / bin.count, count: bin.count }));
  if (!colours.length) return [];
  colours.sort((a, b) => b.count - a.count || a.r - b.r || a.g - b.g || a.b - b.b);
  const centers: Cluster[] = [{ ...colours[0] }];
  while (centers.length < Math.min(count, colours.length)) {
    let furthest = colours[0], bestScore = -1;
    for (const colour of colours) {
      const score = Math.min(...centers.map(center => distance(colour, center))) * Math.sqrt(colour.count);
      if (score > bestScore) { bestScore = score; furthest = colour; }
    }
    if (bestScore <= 0) break;
    centers.push({ ...furthest });
  }
  for (let iteration = 0; iteration < 16; iteration++) {
    const sums: Cluster[] = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (const colour of colours) {
      let closest = 0, closestDistance = Infinity;
      centers.forEach((center, index) => {
        const difference = distance(colour, center);
        if (difference < closestDistance) { closest = index; closestDistance = difference; }
      });
      const sum = sums[closest];
      sum.r += colour.r * colour.count;
      sum.g += colour.g * colour.count;
      sum.b += colour.b * colour.count;
      sum.count += colour.count;
    }
    let movement = 0;
    sums.forEach((sum, index) => {
      if (!sum.count) { centers[index].count = 0; return; }
      const next = { r: sum.r / sum.count, g: sum.g / sum.count, b: sum.b / sum.count, count: sum.count };
      movement += distance(centers[index], next);
      centers[index] = next;
    });
    if (movement < 0.01) break;
  }
  // Rounding can coalesce neighboring centers; merge those results honestly.
  const merged = new Map<string, number>();
  centers.filter(center => center.count > 0).forEach(center => {
    const value = hex(center);
    merged.set(value, (merged.get(value) || 0) + center.count);
  });
  return [...merged].map(([value, weight]) => ({ hex: value, proportion: weight / total })).sort((a, b) => b.proportion - a.proportion || a.hex.localeCompare(b.hex));
}
