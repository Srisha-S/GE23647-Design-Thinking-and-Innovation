import assert from 'node:assert/strict';
import { parseConvertInput } from '../src/lib/convertInput';
import { colorInfo, normalizeHex, parseColor } from '../src/lib/color';
import type { ColourFormat } from '../src/types';

let checks = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); checks++; }

for (const [input, expected] of [
  ['#E0354D', '#E0354D'], ['E0354D', '#E0354D'], ['#e0354d', '#E0354D'],
  [' e0354d ', '#E0354D'], ['#000000', '#000000'], ['#FFFFFF', '#FFFFFF'],
  ['#FF0000', '#FF0000'], ['#00FF00', '#00FF00'], ['#0000FF', '#0000FF'],
]) {
  check(parseConvertInput(input, 'HEX') === expected, `HEX ${JSON.stringify(input)} normalizes to ${expected}.`);
}
for (const [input, expected] of [
  ['224,53,77', '#E0354D'], ['224, 53, 77', '#E0354D'], ['224 53 77', '#E0354D'],
  [' 224\t53\n77 ', '#E0354D'], ['0,0,0', '#000000'], ['255,255,255', '#FFFFFF'],
  ['255,0,0', '#FF0000'], ['0,255,0', '#00FF00'], ['0,0,255', '#0000FF'],
]) {
  check(parseConvertInput(input, 'RGB') === expected, `RGB ${JSON.stringify(input)} becomes ${expected}.`);
}

const invalidHex = ['', '#GG0000', 'bad HEX', '#FFF', 'FFF', '#12345', '#1234567', '#12345678', '##123456', '#12 3456', 'red'];
for (const input of invalidHex) {
  assert.throws(() => parseConvertInput(input, 'HEX'), /6 hexadecimal digits/); checks++;
}
for (const input of ['', '-1,0,0', '256,0,0', '0,0', '0,0,0,0', '224,,77', '224,53,', 'r,53,77', 'NaN,0,0', 'Infinity,0,0', '1e309,0,0', '0xFF,0,0', '0, 0 0', '100%,0,0', 'hsl(0,0,0)']) {
  assert.throws(() => parseConvertInput(input, 'RGB')); checks++;
}
check(parseConvertInput('rgb(224, 53, 77)', 'RGB') === '#E0354D', 'The existing RGB function wrapper remains supported.');
check(parseConvertInput('224.4,53.1,77.2', 'RGB') === '#E0354D', 'Valid decimal RGB channels use shared rounding.');
for (const [format, input, expected] of [
  ['HSL', '0,100,50', '#FF0000'], ['HSL', '120,100%,50%', '#00FF00'],
  ['CMYK', '0,100,100,0', '#FF0000'], ['CMYK', '0%,0%,0%,100%', '#000000'],
  ['LAB', '0,0,0', '#000000'], ['LAB', '100,0,0', '#FFFFFF'],
] as [ColourFormat, string, string][]) {
  check(parseConvertInput(input, format) === expected, `${format} inputs remain compatible with the shared parser.`);
}
for (const [format, input] of [
  ['HSL', '120,101,50'], ['HSL', '361,100,50'], ['CMYK', '0,0,0,101'],
  ['CMYK', '0,0,0'], ['LAB', '101,0,0'], ['LAB', '50,128,0'],
] as [ColourFormat, string][]) {
  assert.throws(() => parseConvertInput(input, format)); checks++;
}
check(normalizeHex('#F00') === '#FF0000' && parseColor('#F00', 'HEX') === '#FF0000', 'Strict Convert input does not remove shorthand support from other CHROMA tools.');

const colour = colorInfo(parseConvertInput('224 53 77', 'RGB'));
check(colour.hex === '#E0354D' && colour.rgb.r === 224 && colour.rgb.g === 53 && colour.rgb.b === 77, 'Convert results use the existing shared colour model.');
for (const format of ['hsl', 'lab', 'cmyk'] as const) {
  check(Object.values(colour[format]).every(Number.isFinite), `The existing ${format.toUpperCase()} output is finite.`);
}
console.log(`${checks} Convert input checks passed.`);
