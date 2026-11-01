import assert from 'node:assert/strict';
import { emptyImageMatch, normaliseMatchTargetMetadata, reduceImageMatch, remapMatchTargetMetadata } from '../src/lib/imageMatch';
import { colorInfo, deltaE } from '../src/lib/color';
import { loadWorkspace, normaliseData, parseLibraryImport, STORAGE_KEY } from '../src/state/storage';
import type { DeviceReading, MatchTargetMetadata } from '../src/types';

let checks = 0;
function check(value: unknown, message: string) { assert.ok(value, message); checks++; }
function equal(actual: unknown, expected: unknown, message: string) { assert.deepEqual(actual, expected, message); checks++; }
const scan: DeviceReading = { hex: '#DC3A50', source: 'bluetooth', timestamp: '2026-09-26T00:00:00Z', clear: 630 };
const libraryMetadata: MatchTargetMetadata = { source: 'library', name: 'Saved coral', libraryItemId: 'coral', libraryProjectId: 'print' };

// Both digital target sources use the same state and colour math in either order.
for (const metadata of [{ source: 'image', imageName: 'local.png' } as MatchTargetMetadata, libraryMetadata]) {
  const targetFirst = reduceImageMatch(emptyImageMatch, { type: 'target', hex: '#e0354d', metadata });
  check(targetFirst.target?.hex === '#E0354D' && targetFirst.sample === null, `${metadata.source} target-first waits for a scan.`);
  equal(targetFirst.target?.rgb, { r: 224, g: 53, b: 77 }, `${metadata.source} target derives RGB from the shared conversion.`);
  check(targetFirst.target?.source === metadata.source, `${metadata.source} provenance is explicit.`);
  const completed = reduceImageMatch(targetFirst, { type: 'reading', reading: scan });
  check(completed.target === targetFirst.target && completed.sample?.hex === scan.hex, `${metadata.source} target-first receives an ordinary BLE SCAN.`);
  check(completed.sample?.clear === 630 && targetFirst.sample === null, `${metadata.source} retains sensor metadata without modifying earlier state.`);
  const scanFirst = reduceImageMatch(emptyImageMatch, { type: 'reading', reading: scan });
  check(scanFirst.target === null && scanFirst.sample?.hex === scan.hex, `${metadata.source} scan-first keeps the physical side while waiting.`);
  equal(reduceImageMatch(scanFirst, { type: 'target', hex: '#E0354D', metadata }), completed, `${metadata.source} produces the same pair in either order.`);
  check(deltaE(completed.target!.hex, completed.sample!.hex) > 0 && deltaE(completed.target!.hex, completed.target!.hex) === 0, `${metadata.source} uses the existing CIEDE2000 utility.`);
  check(Number.isFinite(colorInfo(completed.target!.hex).lab.l), `${metadata.source} uses the existing LAB conversion.`);
}

let state = reduceImageMatch(emptyImageMatch, { type: 'target', hex: '#E0354D', metadata: libraryMetadata });
state = reduceImageMatch(state, { type: 'reading', reading: scan });
const physicalSample = state.sample;
const otherLibraryMetadata: MatchTargetMetadata = { source: 'library', name: 'Blue', libraryItemId: 'blue' };
state = reduceImageMatch(state, { type: 'target', hex: '#123456', metadata: otherLibraryMetadata });
check(state.target?.hex === '#123456' && state.target.libraryItemId === 'blue' && state.sample === physicalSample, 'Replacing Library target preserves the physical sample for immediate recomputation.');
state = reduceImageMatch(state, { type: 'target', hex: '#654321', metadata: { source: 'image', imageName: 'new.jpg' } });
check(state.target?.source === 'image' && state.target.imageName === 'new.jpg' && state.target.libraryItemId === undefined && state.sample === physicalSample, 'Image target replaces Library metadata and retains the physical sample.');
const previousTarget = state.target;
state = reduceImageMatch(state, { type: 'reading', reading: { ...scan, hex: '#E0354D' } });
check(state.target === previousTarget && state.sample?.hex === '#E0354D', 'Rescanning replaces only the physical sample.');
state = reduceImageMatch(state, { type: 'sample', reading: null });
check(state.target === previousTarget && state.sample === null, 'Explicit sample clear preserves the target.');
state = reduceImageMatch(state, { type: 'sample', reading: { ...scan, source: 'sample' } });
check(state.sample?.source === 'sample', 'Explicit latest-colour actions retain their actual provenance.');
const retainedSample = state.sample;
state = reduceImageMatch(state, { type: 'target', hex: null });
check(state.target === null && state.sample === retainedSample, 'Clearing the target preserves the physical sample.');
state = reduceImageMatch(state, { type: 'target', hex: '#E0354D' });
check(state.target?.source === 'image' && state.sample === retainedSample, 'Existing image setter defaults to an image target without discarding the sample.');

for (const source of ['demo', 'usb', 'wifi', 'bluetooth']) {
  state = reduceImageMatch(state, { type: 'reading', reading: { ...scan, source } });
  check(state.sample?.source === source, `The existing ${source} reading path is preserved with honest provenance.`);
}
for (const reading of [null, { ...scan, hex: 'invalid' }, { ...scan, timestamp: 'invalid' }, { ...scan, source: 'imported' }]) {
  check(reduceImageMatch(state, { type: 'reading', reading }) === state, 'Missing or invalid automatic samples do not replace a valid result.');
}
check(reduceImageMatch(state, { type: 'target', hex: 'invalid' }) === state, 'An invalid target is safely rejected.');
check(reduceImageMatch(state, { type: 'target', hex: '#E0354D', metadata: { source: 'unsupported' } as unknown as MatchTargetMetadata }) === state, 'An invalid target source is safely rejected.');
check(reduceImageMatch(state, { type: 'sample', reading: { ...scan, source: '' } }) === state, 'A sample without provenance is rejected.');
check(emptyImageMatch.target === null && emptyImageMatch.sample === null, 'Reducer operations do not mutate the shared empty state.');

// The target is a snapshot, never a mutation of the saved Library colour.
const sourceWorkspace = normaliseData({ projects: [{ id: 'print', name: 'Print' }], colours: [{ id: 'coral', hex: '#e0354d', rgb: { r: 0, g: 0, b: 0 }, name: 'Saved coral', projectId: 'print', tags: ['paint'] }] });
const original = JSON.stringify(sourceWorkspace);
const savedColour = sourceWorkspace.library[0];
const selected = reduceImageMatch(emptyImageMatch, { type: 'target', hex: savedColour.hex, metadata: { source: 'library', name: savedColour.name, libraryItemId: savedColour.id, libraryProjectId: savedColour.projectId } });
equal(selected.target, { ...libraryMetadata, hex: '#E0354D', rgb: { r: 224, g: 53, b: 77 } }, 'Imported Library colour provides normalized target data and source metadata.');
check(selected.target?.rgb !== savedColour.rgb && JSON.stringify(sourceWorkspace) === original, 'Selecting a target snapshots colour values without mutating Library or project associations.');

const comparison = { id: 'library-match', a: '#E0354D', b: '#DC3A50', name: 'Library match', sampleSource: 'bluetooth', matchTarget: libraryMetadata, projectId: 'print' };
const stored = normaliseData({ ...sourceWorkspace, comparisons: [comparison] });
equal(stored.comparisons[0].matchTarget, libraryMetadata, 'Saved Library comparisons retain target metadata.');
const imported = parseLibraryImport({ colours: sourceWorkspace.library, projects: sourceWorkspace.projects, comparisons: [comparison] });
check(imported.comparisons[0].sampleSource === 'bluetooth' && imported.comparisons[0].deviceDeltaE === undefined, 'Library-target JSON retains BLE provenance and app-calculated Delta E.');
equal(normaliseData(JSON.parse(JSON.stringify(stored))).comparisons[0].matchTarget, libraryMetadata, 'Target metadata survives JSON storage round trips.');
const reloaded = loadWorkspace({ getItem: key => key === STORAGE_KEY ? JSON.stringify(stored) : null });
equal(reloaded.comparisons[0].matchTarget, libraryMetadata, 'Workspace reload preserves optional result metadata.');
const imageStored = normaliseData({ comparisons: [{ ...comparison, matchTarget: { source: 'image', imageName: 'flower.webp' }, sampleSource: 'demo' }] });
equal(imageStored.comparisons[0].matchTarget, { source: 'image', imageName: 'flower.webp' }, 'Image results retain image source and local filename.');
check(imageStored.comparisons[0].sampleSource === 'demo', 'Image result persistence retains explicit demo provenance.');
const older = parseLibraryImport({ colours: [{ hex: '#123456', name: 'Old saved colour' }], comparisons: [{ a: '#123456', b: '#112233', name: 'Old comparison' }] });
check(older.library[0].hex === '#123456' && older.comparisons[0].matchTarget === undefined, 'Older Library and comparison exports without metadata remain supported.');
const badMetadata = [null, [], 'library', { source: 'recent' }, { name: 'Missing source' }];
for (const matchTarget of badMetadata) {
  check(parseLibraryImport({ colours: [], comparisons: [{ ...comparison, matchTarget }] }).comparisons[0].matchTarget === undefined, 'Malformed optional metadata is ignored without rejecting an otherwise valid older comparison.');
}
equal(normaliseMatchTargetMetadata({ source: 'library', name: ' Coral ', libraryItemId: ' c ', libraryProjectId: ' p ', imageName: 'discard.jpg', rgb: {}, extra: true }), { source: 'library', name: 'Coral', libraryItemId: 'c', libraryProjectId: 'p' }, 'Metadata is trimmed and only fields for the selected source survive.');
const bounded = normaliseMatchTargetMetadata({ source: 'library', name: 'n'.repeat(200), libraryItemId: 'i'.repeat(200), libraryProjectId: 'p'.repeat(200) });
check(bounded?.name?.length === 80 && bounded.libraryItemId?.length === 100 && bounded.libraryProjectId?.length === 100, 'Imported source metadata has bounded text fields.');
check(normaliseMatchTargetMetadata({ source: 'image', imageName: 'x'.repeat(400) })?.imageName?.length === 255, 'Image filenames are bounded in saved snapshots.');

const libraryMap = new Map([['coral', 'existing-coral']]);
const projectMap = new Map([['print', 'existing-print']]);
equal(remapMatchTargetMetadata(libraryMetadata, libraryMap, projectMap), { ...libraryMetadata, libraryItemId: 'existing-coral', libraryProjectId: 'existing-print' }, 'Import merging remaps source identifiers to the accepted Library/project records.');
equal(remapMatchTargetMetadata(libraryMetadata, new Map(), new Map()), libraryMetadata, 'Standalone match exports keep useful source snapshots even without source records.');
equal(libraryMetadata, { source: 'library', name: 'Saved coral', libraryItemId: 'coral', libraryProjectId: 'print' }, 'Import metadata remapping does not mutate the original snapshot.');
const collided = parseLibraryImport({ projects: [{ id: 'shared', name: 'Project' }], colours: [{ id: 'shared', hex: '#E0354D', name: 'Coral', projectId: 'shared' }], comparisons: [{ ...comparison, matchTarget: { source: 'library', libraryItemId: 'shared', libraryProjectId: 'shared' } }] });
check(collided.library[0].id !== collided.projects[0].id && collided.comparisons[0].matchTarget?.libraryItemId === collided.library[0].id && collided.comparisons[0].matchTarget?.libraryProjectId === collided.projects[0].id, 'Normalization repairs colliding imported IDs while preserving target references.');
console.log(`${checks} Match state and persistence checks passed.`);
