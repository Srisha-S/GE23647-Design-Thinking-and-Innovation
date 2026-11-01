import assert from 'node:assert/strict';
import { extractDominantColours } from '../src/lib/imagePalette.ts';

let checks = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); checks++; }
const solid = extractDominantColours(new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]));
check(solid.length === 1 && solid[0].hex === '#FF0000' && solid[0].proportion === 1, 'A solid image produces one real colour, without invented palette entries.');
const redBluePixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
const redBlue = extractDominantColours(redBluePixels);
check(redBlue.length === 2, 'Two-colour images retain both colours.');
check(redBlue[0].hex === '#FF0000' && redBlue[0].proportion === .75, 'Dominant colour weight matches the pixel distribution.');
check(redBlue[1].hex === '#0000FF' && redBlue[1].proportion === .25, 'Secondary colour weight matches the pixel distribution.');
check(JSON.stringify(redBlue) === JSON.stringify(extractDominantColours(redBluePixels)), 'Extraction is deterministic.');
const transparent = extractDominantColours(new Uint8ClampedArray([0, 255, 0, 0, 255, 0, 0, 128]));
check(transparent.length === 1 && transparent[0].hex === '#FF7F7F', 'Invisible pixels are ignored and partial transparency composites on white.');
check(extractDominantColours(new Uint8ClampedArray([0, 255, 0, 0])).length === 0, 'Fully transparent images have an empty palette.');
check(extractDominantColours([]).length === 0, 'Empty input is handled.');
const varied: number[] = [];
for (let i = 0; i < 1000; i++) varied.push((i * 73) % 256, (i * 31) % 256, (i * 111) % 256, 255);
const variedPalette = extractDominantColours(varied);
check(variedPalette.length === 5, 'Rich images produce five dominant colours.');
check(Math.abs(variedPalette.reduce((sum, colour) => sum + colour.proportion, 0) - 1) < 1e-12, 'Every visible pixel contributes once to the palette.');
check(variedPalette.every(colour => /^#[A-F\d]{6}$/.test(colour.hex)), 'Every extracted value is valid HEX.');
check(new Set(variedPalette.map(colour => colour.hex)).size === variedPalette.length, 'Palette entries are unique.');
check(variedPalette.every((colour, index) => !index || variedPalette[index - 1].proportion >= colour.proportion), 'Palette is ordered by prevalence.');
assert.throws(() => extractDominantColours([0, 0, 0]), /RGBA/); checks++;
assert.throws(() => extractDominantColours([], 0), /between 1 and 12/); checks++;
console.log(`${checks} image palette checks passed.`);
