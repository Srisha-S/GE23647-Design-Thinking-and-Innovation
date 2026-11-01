import assert from 'node:assert/strict';
import { rgbToLab, hexToRgb } from '../src/lib/color.ts';
import { cloneMask, createMask, featherMask, paintStroke, resizeMask } from '../src/features/visualize/mask.ts';
import { ManualMaskProvider } from '../src/features/visualize/maskProvider.ts';
import { blendIntensity, buildRecolour, buildRecolourAsync, type ImagePixels } from '../src/features/visualize/recolor.ts';
import { LIGHTING_PRESETS, MATERIAL_PROFILES, type LightingMode, type MaterialType } from '../src/features/visualize/materialProfiles.ts';

let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) { assert.deepEqual(actual, expected, label); checks++; }
function ok(actual: unknown, label: string) { assert.ok(actual, label); checks++; }
function throws(fn: () => unknown, label: string) { assert.throws(fn, label); checks++; }
function pixels(values: number[][], width = values.length): ImagePixels {
  return { width, height: values.length / width, data: new Uint8ClampedArray(values.flatMap(value => value.length === 3 ? [...value, 255] : value)) };
}
function fullMask(width: number, height: number) { const mask = createMask(width, height); mask.data.fill(255); return mask; }
function labAt(image: ImagePixels, pixel: number) {
  return rgbToLab({ r: image.data[pixel * 4], g: image.data[pixel * 4 + 1], b: image.data[pixel * 4 + 2] });
}

const empty = createMask(12, 10);
equal(empty.data.length, 120, 'Masks store one alpha byte per natural pixel.');
equal(empty.data.some(Boolean), false, 'New selection starts empty.');
const brush = cloneMask(empty);
paintStroke(brush, { x: 3.5, y: 4.5 }, { x: 3.5, y: 4.5 }, 1.5, 'brush');
equal(brush.data[4 * 12 + 3], 255, 'Brush paints its centre fully.');
equal(brush.data[0], 0, 'Brush leaves unrelated pixels untouched.');
equal(empty.data.some(Boolean), false, 'A cloned mask owns its alpha buffer.');
const large = cloneMask(empty);
paintStroke(large, { x: 3.5, y: 4.5 }, { x: 3.5, y: 4.5 }, 3, 'brush');
ok(large.data.filter(Boolean).length > brush.data.filter(Boolean).length, 'Increasing brush radius increases coverage.');
const stroke = cloneMask(empty);
paintStroke(stroke, { x: .5, y: 2.5 }, { x: 11.5, y: 2.5 }, 1, 'brush');
ok(Array.from(stroke.data.slice(24, 36)).every(value => value === 255), 'Fast pointer movement creates a continuous interpolated stroke.');
const clipped = createMask(4, 4);
paintStroke(clipped, { x: -.5, y: -.5 }, { x: .5, y: .5 }, 2, 'brush');
equal(clipped.data[0], 255, 'A brush touching the top-left boundary paints the edge.');
equal(clipped.data[15], 0, 'Clipping cannot wrap a stroke onto the opposite image edge.');
paintStroke(clipped, { x: 3.5, y: 3.5 }, { x: 9, y: 9 }, 1, 'brush');
equal(clipped.data[15], 255, 'A brush can touch the bottom-right boundary.');
const beforeErase = stroke.data.slice();
paintStroke(stroke, { x: 4.5, y: 2.5 }, { x: 7.5, y: 2.5 }, 1, 'eraser');
equal(stroke.data[24 + 5], 0, 'Eraser removes the selected stroke centre.');
equal(stroke.data[24], beforeErase[24], 'Eraser preserves distant mask coverage.');
const safeStroke = cloneMask(stroke);
paintStroke(stroke, { x: NaN, y: 0 }, { x: 0, y: 0 }, 2, 'brush');
paintStroke(stroke, { x: 0, y: 0 }, { x: 0, y: 0 }, -2, 'brush');
paintStroke(stroke, { x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }, 2, 'brush');
equal(stroke, safeStroke, 'Malformed pointer samples and invalid brush size are safely ignored.');

const block = createMask(7, 7);
for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) block.data[y * 7 + x] = 255;
const feather = featherMask(block);
equal(feather.data[0], 0, 'Feather does not expand the selection outside its boundary.');
equal(feather.data[3 * 7 + 3], 255, 'Feather keeps the selected interior fully opaque.');
ok(feather.data[1 * 7 + 1] > 0 && feather.data[1 * 7 + 1] < 255, 'Only selection edges become partially transparent.');
ok(feather.data.every((value, index) => value <= block.data[index]), 'Feather never increases original alpha anywhere.');
equal(block.data[8], 255, 'Feather leaves the editing mask unchanged.');
equal(featherMask(fullMask(3, 2)).data, fullMask(3, 2).data, 'Selected image boundaries do not fade toward a fictitious outside image.');
equal(featherMask(block, 0), block, 'Zero feather produces an identical independent mask.');
const pair = createMask(2, 1); pair.data.set([0, 255]);
equal(Array.from(resizeMask(pair, 4, 1).data), [0, 64, 191, 255], 'Mask resizing uses smooth pixel-centred bilinear alpha interpolation.');
equal(resizeMask(fullMask(2, 2), 8, 6).data.every(value => value === 255), true, 'Upscaling preserves a fully selected surface.');
const sameSize = resizeMask(pair, 2, 1); sameSize.data[0] = 99;
equal(pair.data[0], 0, 'Resizing to identical dimensions still returns an independent mask.');
throws(() => createMask(0, 1), 'Zero image dimensions are rejected.');
throws(() => createMask(1.2, 1), 'Fractional dimensions are rejected.');
throws(() => createMask(100000, 100000), 'Unbounded mask allocations are rejected.');
throws(() => featherMask(block, Infinity), 'Invalid feather radius is rejected.');
throws(() => resizeMask({ ...pair, data: new Uint8ClampedArray(1) }, 3, 3), 'Truncated mask alpha is rejected.');

const provider = new ManualMaskProvider(20, 3);
equal(provider.canUndo, false, 'Fresh manual provider has no undo entry.');
provider.beginStroke();
provider.stroke({ x: .5, y: 1.5 }, { x: 5.5, y: 1.5 }, .5, 'brush');
provider.stroke({ x: 5.5, y: 1.5 }, { x: 10.5, y: 1.5 }, .5, 'brush');
equal(provider.endStroke(), true, 'Multiple pointer moves commit as one stroke.');
equal(provider.canUndo, true, 'Completed changed stroke becomes undoable.');
equal(provider.undo(), true, 'Undo restores the entire stroke.');
equal(provider.mask.data.some(Boolean), false, 'Undo restores pre-stroke alpha exactly.');
equal(provider.canUndo, false, 'A multi-move stroke consumed one history slot.');
provider.beginStroke(); provider.stroke({ x: .5, y: 1.5 }, { x: .5, y: 1.5 }, 1, 'eraser');
equal(provider.endStroke(), false, 'Erasing an empty selection is a no-op.');
equal(provider.canUndo, false, 'No-op stroke does not consume undo history.');
provider.stroke({ x: 5.5, y: 1.5 }, { x: 10.5, y: 1.5 }, 1, 'brush'); provider.cancelStroke();
equal(provider.mask.data.some(Boolean), false, 'Pointer cancellation restores the pre-stroke selection.');
equal(provider.canUndo, false, 'Cancelled strokes do not create undo entries.');
provider.replace(fullMask(20, 3));
equal(provider.mask.data.every(value => value === 255), true, 'A future provider mask can be adopted without changing the manual API.');
equal(provider.clear(), true, 'Clear selection empties a non-empty mask.');
equal(provider.mask.data.some(Boolean), false, 'Clear removes all alpha.');
provider.undo();
equal(provider.mask.data.every(value => value === 255), true, 'Clear selection is undoable.');
const replacement = createMask(20, 3); replacement.data[1] = 200;
provider.replace(replacement); replacement.data[1] = 0;
equal(provider.mask.data[1], 200, 'Adopting a provider mask retains an independent snapshot.');
throws(() => provider.replace(createMask(2, 2)), 'Provider masks with incompatible image dimensions are rejected.');
const bounded = new ManualMaskProvider(20, 1);
for (let x = 0; x < 12; x++) { bounded.stroke({ x: x + .5, y: .5 }, { x: x + .5, y: .5 }, .4, 'brush'); bounded.endStroke(); }
let undos = 0; while (bounded.undo()) undos++;
equal(undos, 8, 'Manual mask history is bounded to eight snapshots.');
equal(bounded.mask.data.filter(Boolean).length, 4, 'Evicting old history retains older committed paint.');

const photograph = pixels(Array.from({ length: 49 }, (_, i) => [70 + i * 3, 100 + i, 90 + i, i % 7 === 0 ? 128 : 255]), 7);
const originalBytes = photograph.data.slice(), originalMask = block.data.slice();
const recoloured = buildRecolour(photograph, block, '#CC5577');
ok(recoloured.data.some((value, i) => value !== photograph.data[i]), 'The selected object receives the target colour transformation.');
ok(block.data.every((alpha, p) => alpha || recoloured.data.slice(p * 4, p * 4 + 4).every((value, channel) => value === photograph.data[p * 4 + channel])), 'Every RGBA byte outside the original mask is unchanged.');
ok(recoloured.data.every((value, i) => i % 4 !== 3 || value === photograph.data[i]), 'All original alpha bytes are preserved.');
equal(photograph.data, originalBytes, 'Recolour leaves the source image untouched.');
equal(block.data, originalMask, 'Recolour leaves the editing mask untouched.');
equal(buildRecolour(photograph, createMask(7, 7), '#00FF00'), photograph, 'An empty selection returns the original image unchanged.');
const transparent = pixels([[120, 120, 120, 0], [120, 120, 120, 128]]);
const transparentOutput = buildRecolour(transparent, fullMask(2, 1), '#0066CC');
equal(Array.from(transparentOutput.data.slice(0, 4)), [120, 120, 120, 0], 'Invisible source pixels retain even their hidden RGB bytes.');
equal(transparentOutput.data[7], 128, 'A partially transparent selected pixel retains its original alpha.');

const grey = pixels([[128, 128, 128]]);
const midtone = buildRecolour(grey, fullMask(1, 1), '#CC5577');
const expected = hexToRgb('#CC5577');
ok(Math.abs(midtone.data[0] - expected.r) <= 1 && Math.abs(midtone.data[1] - expected.g) <= 1 && Math.abs(midtone.data[2] - expected.b) <= 1, 'Uniform selected midtone maps to the target RGB through the existing LAB utilities.');
const green = buildRecolour(grey, fullMask(1, 1), '#40A070');
ok(labAt(green, 0).a < -20, 'Target chroma is applied instead of a neutral brightness-only overlay.');
const ramp = pixels([25, 55, 85, 115, 145, 175, 205, 235, 253].map(value => [value, value, value]));
for (const target of ['#CC5577', '#FFD426', '#164E80', '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF']) {
  const result = buildRecolour(ramp, fullMask(ramp.width, 1), target);
  const lightness = Array.from({ length: ramp.width }, (_, p) => labAt(result, p).l);
  ok(lightness.every((value, i) => i === 0 || value > lightness[i - 1]), `${target}: dark folds remain darker and highlights brighter across the surface.`);
  ok(lightness.at(-1)! - lightness[0] > 40, `${target}: lighting and local texture are not flattened to one colour.`);
}
const specular = buildRecolour(pixels([[128, 128, 128], [255, 255, 255]]), fullMask(2, 1), '#224477');
ok(labAt(specular, 1).l > 99 && Math.hypot(labAt(specular, 1).a, labAt(specular, 1).b) < 1, 'A strong neutral specular reflection stays bright and neutral.');
const texture = pixels([100, 105, 100, 95, 100, 105, 100, 95].map(value => [value, value, value]));
const fabric = buildRecolour(texture, fullMask(8, 1), '#6688AA');
ok(labAt(fabric, 1).l > labAt(fabric, 0).l && labAt(fabric, 3).l < labAt(fabric, 0).l && labAt(fabric, 5).l > labAt(fabric, 4).l, 'Fine alternating texture remains present without blurring image pixels.');
equal(blendIntensity(photograph, recoloured, 0), photograph, 'Zero percent intensity is byte-identical to the original.');
equal(blendIntensity(photograph, recoloured, 100), recoloured, 'One hundred percent intensity is the full transformed image.');
const half = blendIntensity(photograph, recoloured, 50);
ok(half.data.every((value, i) => i % 4 === 3 ? value === photograph.data[i] : Math.abs(value - (photograph.data[i] + recoloured.data[i]) / 2) <= .5), 'Fifty percent intensity is the natural rounded midpoint and preserves alpha.');
ok(block.data.every((alpha, p) => alpha || half.data.slice(p * 4, p * 4 + 4).every((value, channel) => value === photograph.data[p * 4 + channel])), 'Intensity adjustment cannot alter unselected pixels.');
throws(() => blendIntensity(photograph, recoloured, -1), 'Negative intensity is rejected.');
throws(() => blendIntensity(photograph, recoloured, NaN), 'Non-finite intensity is rejected.');
throws(() => blendIntensity(photograph, recoloured, 101), 'Intensity above 100 is rejected.');
throws(() => buildRecolour(photograph, createMask(1, 1), '#ABCDEF'), 'Mismatched source/mask dimensions are rejected.');
throws(() => buildRecolour({ ...grey, data: new Uint8ClampedArray(3) }, fullMask(1, 1), '#ABCDEF'), 'Truncated source RGBA is rejected.');
throws(() => buildRecolour(grey, fullMask(1, 1), '#NOTHEX'), 'Malformed target colour is rejected using the shared colour parser.');
throws(() => blendIntensity(photograph, grey, 50), 'Mismatched preview dimensions are rejected.');
equal(await buildRecolourAsync(photograph, block, '#CC5577', { yieldEveryRows: 1 }), recoloured, 'Chunked rendering yields the same pixels as synchronous preview rendering.');
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(buildRecolourAsync(photograph, block, '#CC5577', { signal: cancelled.signal }), { name: 'AbortError' }); checks++;
const during = new AbortController();
const rendering = buildRecolourAsync(photograph, block, '#CC5577', { signal: during.signal, yieldEveryRows: 1 });
setTimeout(() => during.abort(), 0);
await assert.rejects(rendering, { name: 'AbortError' }); checks++;
equal(photograph.data, originalBytes, 'Cancelling final rendering does not mutate the original image.');

equal(MATERIAL_PROFILES.map(item => item.id), ['fabric', 'paint', 'wood', 'plastic', 'metal', 'ceramic'], 'Six material profiles are shared with the Visualize UI.');
equal(LIGHTING_PRESETS.map(item => item.id), ['daylight', 'neutral', 'warm', 'cool'], 'Four approximate LightShift modes are shared with the UI.');
ok(Object.isFrozen(MATERIAL_PROFILES) && MATERIAL_PROFILES.every(Object.isFrozen), 'Material presets cannot be mutated accidentally by preview controls.');
ok(Object.isFrozen(LIGHTING_PRESETS) && LIGHTING_PRESETS.every(Object.isFrozen), 'LightShift presets cannot be mutated accidentally by preview controls.');
equal(buildRecolour(photograph, block, '#CC5577', { material: 'fabric', lighting: 'daylight' }), recoloured, 'Explicit Fabric and Daylight reproduce the existing recolour API byte for byte.');

// Preservation checks cover both material transforms and every light cast.
// The photographed surface and alpha remain authoritative throughout.
for (const material of MATERIAL_PROFILES) {
  for (const lighting of LIGHTING_PRESETS) {
    const options = { material: material.id, lighting: lighting.id };
    const result = buildRecolour(photograph, block, '#547896', options);
    const label = `${material.label} / ${lighting.label}`;
    ok(block.data.every((alpha, p) => alpha || result.data.slice(p * 4, p * 4 + 4).every((value, channel) => value === photograph.data[p * 4 + channel])), `${label}: every mask-exterior RGBA byte stays unchanged.`);
    ok(result.data.every((value, i) => i % 4 !== 3 || value === photograph.data[i]), `${label}: existing alpha is unchanged, including translucent pixels.`);
    equal(buildRecolour(photograph, createMask(7, 7), '#547896', options), photograph, `${label}: an empty mask leaves the entire image byte-identical.`);
    const hidden = buildRecolour(transparent, fullMask(2, 1), '#547896', options);
    equal(Array.from(hidden.data.slice(0, 4)), [120, 120, 120, 0], `${label}: transparent selected pixels keep their hidden RGB bytes.`);
    const folds = buildRecolour(ramp, fullMask(ramp.width, 1), '#547896', options);
    const foldsL = Array.from({ length: ramp.width }, (_, p) => labAt(folds, p).l);
    ok(foldsL.every((value, i) => i === 0 || value > foldsL[i - 1]), `${label}: shadow-to-highlight ordering survives material and lighting changes.`);
    ok(foldsL.at(-1)! - foldsL[0] > 50, `${label}: folds retain a wide brightness range instead of a flat fill.`);
    const woven = buildRecolour(texture, fullMask(8, 1), '#547896', options);
    ok(labAt(woven, 1).l > labAt(woven, 0).l && labAt(woven, 3).l < labAt(woven, 0).l && labAt(woven, 5).l > labAt(woven, 4).l, `${label}: original fine alternating detail remains in place.`);
    const shine = buildRecolour(pixels([[90, 90, 90], [170, 170, 170], [255, 255, 255]]), fullMask(3, 1), '#547896', options);
    ok(labAt(shine, 2).l > 99 && Math.hypot(labAt(shine, 2).a, labAt(shine, 2).b) < 1, `${label}: fully white specular pixels remain white and bright.`);
  }
  const options = { material: material.id, lighting: 'warm' as const };
  equal(await buildRecolourAsync(photograph, block, '#547896', { ...options, yieldEveryRows: 1 }), buildRecolour(photograph, block, '#547896', options), `${material.label}: cancellable full-size render matches the material-aware preview.`);
}
equal(photograph.data, originalBytes, 'Every material/light combination preserves the original image buffer.');
equal(block.data, originalMask, 'Every material/light combination preserves the original editing mask.');

const surface = pixels([[100, 100, 100], [128, 128, 128], [170, 170, 170], [220, 220, 220]]);
const surfaceMask = fullMask(4, 1);
const daylight = buildRecolour(surface, surfaceMask, '#547896', { lighting: 'daylight' });
const neutral = buildRecolour(surface, surfaceMask, '#547896', { lighting: 'neutral' });
const warm = buildRecolour(surface, surfaceMask, '#547896', { lighting: 'warm' });
const cool = buildRecolour(surface, surfaceMask, '#547896', { lighting: 'cool' });
ok(labAt(warm, 1).b > labAt(neutral, 1).b && labAt(neutral, 1).b > labAt(daylight, 1).b && labAt(daylight, 1).b > labAt(cool, 1).b, 'LightShift changes the selected midtone from warm to cool in the intended order.');
ok(Math.abs(labAt(warm, 1).l - labAt(daylight, 1).l) < 1 && Math.abs(labAt(cool, 1).l - labAt(daylight, 1).l) < 1, 'Approximate colour casts retain midtone brightness rather than applying a dark overlay.');
const profileResults = MATERIAL_PROFILES.map(profile => Array.from(buildRecolour(surface, surfaceMask, '#547896', { material: profile.id }).data).join(','));
equal(new Set(profileResults).size, MATERIAL_PROFILES.length, 'The six presets have distinct photographic appearance behaviour.');

const woodGrain = pixels([[128, 128, 128], [148, 115, 96], [128, 128, 128], [101, 136, 155], [128, 128, 128]]);
const grainMask = fullMask(5, 1);
const grainFabric = buildRecolour(woodGrain, grainMask, '#808080', { material: 'fabric' });
const grainWood = buildRecolour(woodGrain, grainMask, '#808080', { material: 'wood' });
ok(labAt(grainWood, 1).b > labAt(grainFabric, 1).b + 3 && labAt(grainWood, 3).b < labAt(grainFabric, 3).b - 3, 'Wood retains the existing warm/cool grain deviations without retaining the old base colour.');
const highlightSurface = pixels([[80, 80, 80], [170, 170, 170], [225, 225, 225]]);
const matte = buildRecolour(highlightSurface, fullMask(3, 1), '#224477', { material: 'paint' });
const shiny = buildRecolour(highlightSurface, fullMask(3, 1), '#224477', { material: 'metal' });
ok(labAt(shiny, 2).l > labAt(matte, 2).l + 1, 'Metal retains more photographed bright reflection light than matte paint.');
ok(Math.hypot(labAt(shiny, 2).a, labAt(shiny, 2).b) < Math.hypot(labAt(matte, 2).a, labAt(matte, 2).b), 'A metal reflection has less recolouring chroma than the matte surface.');

const measuredLab = rgbToLab(hexToRgb('#547896'));
const originalLab = { ...measuredLab };
equal(buildRecolour(grey, fullMask(1, 1), '#FF0000', { targetLab: measuredLab }), buildRecolour(grey, fullMask(1, 1), '#547896'), 'A supplied scanned LAB value takes precedence over the display HEX without an RGB round-trip.');
const measuredWarm = buildRecolour(grey, fullMask(1, 1), '#FF0000', { targetLab: measuredLab, material: 'fabric', lighting: 'warm' });
ok(labAt(measuredWarm, 0).b > measuredLab.b + 5, 'Measured LAB also participates in the approximate LightShift preview.');
equal(measuredLab, originalLab, 'A scanned LAB object remains unchanged when material and lighting are applied.');
throws(() => buildRecolour(grey, fullMask(1, 1), '#547896', { targetLab: { l: NaN, a: 0, b: 0 } }), 'Non-finite measured LAB is rejected instead of entering the colour library.');
throws(() => buildRecolour(grey, fullMask(1, 1), '#547896', { targetLab: { l: 50, a: 128, b: 0 } }), 'Out-of-range measured LAB chroma is rejected safely.');
throws(() => buildRecolour(grey, fullMask(1, 1), '#547896', { targetLab: { l: 101, a: 0, b: 0 } }), 'Out-of-range measured lightness is rejected safely.');
throws(() => buildRecolour(grey, fullMask(1, 1), '#547896', { material: 'unrecognised' as MaterialType }), 'Unknown persisted material presets are rejected explicitly.');
throws(() => buildRecolour(grey, fullMask(1, 1), '#547896', { lighting: 'unrecognised' as LightingMode }), 'Unknown persisted lighting modes are rejected explicitly.');
equal(blendIntensity(photograph, buildRecolour(photograph, block, '#547896', { material: 'metal', lighting: 'warm' }), 0), photograph, 'Zero intensity bypasses both material recolouring and the LightShift cast.');

const interruptedMaterial = new AbortController();
const materialRender = buildRecolourAsync(photograph, block, '#547896', { material: 'wood', lighting: 'cool', targetLab: measuredLab, signal: interruptedMaterial.signal, yieldEveryRows: 1 });
setTimeout(() => interruptedMaterial.abort(), 0);
await assert.rejects(materialRender, { name: 'AbortError' }); checks++;
equal(photograph.data, originalBytes, 'Cancelling a material/light render leaves the original intact.');

console.log(`${checks} Visualize mask/recolour checks passed.`);
