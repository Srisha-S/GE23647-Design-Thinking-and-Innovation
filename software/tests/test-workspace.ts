import assert from 'node:assert/strict';
import { colorInfo, hslToRgb, parseColor } from '../src/lib/color';
import { normalisePersistedColour, type PersistedColourDiagnostic } from '../src/lib/persistedColour';
import { withColourRenderContext } from '../src/lib/runtimeDiagnostics';
import { loadWorkspace, loadWorkspaceState, normaliseData, parseLibraryImport, persistWorkspace, seedWorkspace, STORAGE_KEY } from '../src/state/storage';
import { createProjectFolder, insertProjectFolder, mergeProjectFolders, moveProjectsToFolder, removeProjectFolder, remapProjectFolder, renameProjectFolder } from '../src/lib/projectFolders';

let checks = 0;
const failures: string[] = [];
function check(condition: unknown, message: string) { checks++; assert.ok(condition, message); }
function equal(actual: unknown, expected: unknown, message: string) { checks++; assert.deepEqual(actual, expected, message); }
function rejects(action: () => unknown, message: string) { checks++; assert.throws(action, undefined, message); }
function test(name: string, action: () => void) { try { action(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
const stamp = '2025-07-08T10:11:12.000Z';
const fakeStorage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
function writableStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  const writes: Array<{ key: string; value: string }> = [];
  return { values, writes, getItem: (key: string) => values[key] ?? null, setItem(key: string, value: string) { writes.push({ key, value }); values[key] = value; } };
}

test('Seed data', () => {
  const seed = seedWorkspace();
  equal(seed.version, 2, 'Seed uses the current workspace version.');
  equal(seed.library.map(colour => colour.name), ['Terracotta', 'Deep Blue', 'Warm Sand', 'Forest Green', 'Soft Beige', 'Charcoal'], 'All requested sample colours are present.');
  equal(seed.latest.hex, '#C76B4A', 'The initial current colour is Terracotta.');
  equal(seed.history.length, 4, 'Recent sample colours are available.');
  equal(seed.projects.length, 1, 'A single sample project is created.');
  equal(seed.projects[0].name, 'Summer Packaging', 'The requested sample project is available.');
  check(seed.projects[0].notes.includes('Terracotta'), 'The sample project contains useful notes.');
  equal(seed.library.filter(colour => colour.projectId === seed.projects[0].id).length, 3, 'Sample project links reference colours.');
  equal(seed.comparisons[0].projectId, seed.projects[0].id, 'Sample project links a comparison.');
  equal(seed.library[0].rgb, { r: 199, g: 107, b: 74 }, 'Sample RGB is calculated from HEX.');
  equal(loadWorkspace(fakeStorage({})).library.map(colour => colour.hex), seed.library.map(colour => colour.hex), 'An empty store seeds the workspace.');
});

const legacy = {
  latest: { id: 'latest-old', hex: '#c76b4a', name: 'My clay', timestamp: stamp, source: 'demo', project: 'My collection' },
  library: [
    { id: 'old-colour-a', hex: '#abc', name: 'Custom pale blue', timestamp: stamp, source: 'image', project: 'Autumn Proofs' },
    { id: 'old-colour-b', hex: '#274c77', name: 'Ink reference', timestamp: stamp, source: 'usb', project: 'Autumn Proofs' },
  ],
  history: [{ id: 'old-scan', hex: '#e8d3aa', name: 'Warm sample', timestamp: stamp, source: 'demo' }],
  comparisons: [{ id: 'old-comparison', a: '#c76b4a', b: '#c86a4b', name: 'Approved proof', timestamp: stamp, project: 'Autumn Proofs' }],
};

test('V1 migration', () => {
  const before = JSON.stringify(legacy);
  const migrated = loadWorkspace(fakeStorage({ 'chroma-workspace-v1': before }));
  equal(migrated.version, 2, 'Legacy data is upgraded to v2.');
  equal(migrated.library.length, 2, 'Legacy library entries are retained.');
  equal(migrated.library.map(colour => colour.name), ['Custom pale blue', 'Ink reference'], 'Custom legacy names are retained.');
  equal(migrated.library.map(colour => colour.hex), ['#AABBCC', '#274C77'], 'Legacy HEX is normalized.');
  equal(migrated.library[0].createdAt, stamp, 'Legacy colour timestamp is retained.');
  equal(migrated.library[0].source, 'image', 'Legacy source is retained.');
  equal(migrated.library[0].tags, [], 'Older colours receive an empty tags list.');
  equal(migrated.history[0].name, 'Warm sample', 'Scan history is retained.');
  equal(migrated.history[0].createdAt, stamp, 'Scan dates are retained.');
  equal(migrated.latest.name, 'My clay', 'Latest custom colour is retained.');
  equal(migrated.latest.createdAt, stamp, 'Latest capture date is retained.');
  equal(migrated.comparisons[0].name, 'Approved proof', 'Comparison titles are retained.');
  equal(migrated.comparisons[0].createdAt, stamp, 'Comparison dates are retained.');
  const autumn = migrated.projects.find(project => project.name === 'Autumn Proofs');
  check(autumn, 'Legacy collection becomes a project.');
  equal(migrated.library[0].projectId, autumn?.id, 'Migrated colour links its collection project.');
  equal(migrated.library[1].projectId, autumn?.id, 'Repeated collection names share one project.');
  equal(migrated.comparisons[0].projectId, autumn?.id, 'Migrated comparison links its collection project.');
  check(migrated.projects.some(project => project.name === 'Summer Packaging'), 'The requested sample project is supplied during migration.');
  equal(JSON.stringify(legacy), before, 'Migration does not mutate the input object.');
});

test('V2 restoration and fallback', () => {
  const seed = seedWorkspace();
  seed.projects[0].notes = 'Custom project notes\nA second line.';
  seed.library[0].name = 'A renamed colour';
  seed.library[0].tags = ['print', 'approved'];
  const encoded = JSON.stringify(seed);
  const restored = loadWorkspace(fakeStorage({ [STORAGE_KEY]: encoded, 'chroma-workspace-v1': JSON.stringify(legacy) }));
  equal(restored, seed, 'V2 restores colour, project, comparison and metadata without changes.');
  const empty = normaliseData({ library: [], comparisons: [], projects: [], history: [] });
  const emptyRestored = loadWorkspace(fakeStorage({ [STORAGE_KEY]: JSON.stringify(empty) }));
  equal(emptyRestored.library.length, 0, 'An intentionally empty library stays empty.');
  equal(emptyRestored.projects.length, 0, 'Deleted sample projects do not return on refresh.');
  const recovered = loadWorkspace(fakeStorage({ [STORAGE_KEY]: '{broken', 'chroma-workspace-v1': JSON.stringify(legacy) }));
  equal(recovered.library.map(colour => colour.name), ['Custom pale blue', 'Ink reference'], 'A corrupt current snapshot falls back to the valid legacy snapshot.');
  equal(loadWorkspace(fakeStorage({ [STORAGE_KEY]: '{broken' })).library.length, 6, 'A corrupt store still permits startup.');
  equal(loadWorkspace({ getItem: () => { throw new Error('Storage is blocked'); } }).library.length, 6, 'Unavailable browser storage still permits startup.');
});

test('No record truncation', () => {
  const many = normaliseData({
    projects: Array.from({ length: 35 }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}`, createdAt: stamp })),
    library: Array.from({ length: 1205 }, (_, i) => ({ id: `c-${i}`, hex: '#C76B4A', name: `Colour ${i}`, createdAt: stamp, projectId: `p-${i % 35}` })),
    history: Array.from({ length: 75 }, (_, i) => ({ id: `h-${i}`, hex: '#274C77', name: `Scan ${i}`, createdAt: stamp })),
    comparisons: Array.from({ length: 205 }, (_, i) => ({ id: `x-${i}`, a: '#C76B4A', b: '#C86A4B', name: `Proof ${i}`, createdAt: stamp, projectId: `p-${i % 35}` })),
  });
  equal(many.library.length, 1205, 'Large saved libraries are not silently truncated.');
  equal(many.history.length, 75, 'Loading existing history does not truncate records.');
  equal(many.comparisons.length, 205, 'Saved comparisons are not silently truncated.');
  equal(many.projects.length, 35, 'Saved projects are not silently truncated.');
  equal(many.library[1204].name, 'Colour 1204', 'The final imported colour remains available.');
});

test('Untrusted records and IDs', () => {
  const input = {
    projects: [{ id: 'duplicate', name: 'Valid project' }, { id: 'duplicate', name: 'Duplicate ID project' }, { id: 123, name: 'Numeric ID project' }],
    library: [
      { id: 'duplicate', hex: '#C76B4A', name: 'Keep custom name', rgb: { r: -1, g: 999, b: 3 }, projectId: 'duplicate', tags: [' warm ', 'warm', '', 4, 'approved'] },
      { id: '  ', hex: '#fff', projectId: 'missing-project' },
      { id: { bad: 'value' }, hex: '#000' },
      { id: 'invalid-colour', hex: '#NOTHEX' },
    ],
    comparisons: [{ id: 'duplicate', a: '#abc', b: '#def' }, { a: '#123456', b: 'invalid' }],
  };
  const before = JSON.stringify(input);
  const normalized = normaliseData(input);
  const ids = [...normalized.projects, ...normalized.library, ...normalized.history, ...normalized.comparisons, normalized.latest].map(item => item.id);
  check(ids.every(id => typeof id === 'string' && id.trim()), 'Missing, blank and non-string IDs are repaired.');
  equal(new Set(ids).size, ids.length, 'Duplicate IDs are repaired across record groups.');
  equal(normalized.library.length, 3, 'Invalid saved colours are removed during tolerant restoration.');
  equal(normalized.comparisons.length, 1, 'Invalid comparisons are removed during tolerant restoration.');
  equal(normalized.library[0].rgb, { r: 199, g: 107, b: 74 }, 'Untrusted RGB is recomputed from the canonical HEX.');
  equal(normalized.library[0].tags, ['warm', 'approved'], 'Tags are trimmed, deduplicated and validated.');
  equal(normalized.library[0].name, 'Keep custom name', 'Valid custom names survive validation.');
  equal(normalized.library[0].projectId, normalized.projects[0].id, 'Valid project IDs preserve their relationship.');
  equal(normalized.library[1].projectId, undefined, 'Dangling project references are discarded.');
  equal(JSON.stringify(input), before, 'Normalization leaves input records untouched.');
});

test('Library backup import', () => {
  const exported = seedWorkspace();
  const imported = parseLibraryImport({ product: 'CHROMA', version: 2, colours: exported.library, comparisons: exported.comparisons, projects: exported.projects });
  equal(imported.library, exported.library, 'Colour backup imports preserve names, RGB, tags, creation dates and project links.');
  equal(imported.comparisons, exported.comparisons, 'Comparison backup imports preserve saved proofs.');
  equal(imported.projects, exported.projects, 'Project backup imports preserve notes.');
  equal(parseLibraryImport({ library: [{ hex: '#abc', name: 'Legacy export' }] }).library[0].hex, '#AABBCC', 'The earlier library-key format is accepted.');
  equal(parseLibraryImport({ colours: [] }).library.length, 0, 'Empty backups are valid.');
  const existingSnapshot = JSON.stringify(exported);
  const invalid = [
    null, [], {}, { colours: 'not an array' },
    { colours: [{ hex: '#C76B4A' }, { hex: 'invalid' }] },
    { library: [{ hex: '#GGGGGG' }] },
    { colours: [], comparisons: [{ a: '#FFFFFF', b: 'invalid' }] },
    { colours: [{ hex: 'invalid' }], library: [{ hex: '#FFFFFF' }] },
  ];
  for (const data of invalid) {
    const before = JSON.stringify(data);
    rejects(() => parseLibraryImport(data), `Invalid backup ${before} is rejected as a whole.`);
    equal(JSON.stringify(data), before, 'An invalid backup is not mutated.');
    equal(JSON.stringify(exported), existingSnapshot, 'Parsing an invalid backup cannot change the existing workspace.');
  }
});


test('Project folders hydrate safely without changing older project data', () => {
  const old = normaliseData({ projects: [{ id: 'old-project', name: 'Before folders', notes: 'Keep these notes', createdAt: stamp }], library: [{ id: 'old-colour', hex: '#000075', projectId: 'old-project', favourite: true }] });
  equal(old.folders, [], 'Pre-folder workspaces receive an empty folder list.');
  equal(old.projects[0], { id: 'old-project', name: 'Before folders', notes: 'Keep these notes', createdAt: stamp }, 'Legacy project fields survive exactly, without a fabricated grouping.');
  equal(old.library[0].projectId, 'old-project', 'Legacy palette relationships remain intact.');
  for (const folders of [undefined, null, {}, 'old data', [null, false]]) {
    const restored = normaliseData({ projects: old.projects, library: old.library, folders });
    equal(restored.folders, [], 'Malformed optional folder containers cannot crash older workspaces.');
    equal(restored.projects, old.projects, 'A malformed folder list cannot delete or rewrite the project.');
  }
  const raw = JSON.stringify({ version: 2, projects: old.projects, library: old.library });
  const store = writableStorage({ [STORAGE_KEY]: raw });
  const loaded = loadWorkspaceState(store);
  equal(store.writes, [], 'Folder hydration never automatically rewrites old storage.');
  equal(persistWorkspace(loaded, loaded.workspace).status, 'unchanged', 'Normalizing an absent folder field remains non-destructive.');
  const edited = insertProjectFolder(loaded.workspace, createProjectFolder('Proofs', 'folder-proof', stamp));
  equal(persistWorkspace(loaded, edited).status, 'saved', 'A user-created folder can persist after protecting the original.');
  equal(store.getItem(loaded.preservation[0].backupKey!), raw, 'The exact pre-folder data receives a verified recovery copy.');
  equal(loadWorkspace(fakeStorage(store.values)).folders, edited.folders, 'Folders survive a cold reload.');
});

test('Folders move, stack and ungroup projects without touching colour data', () => {
  const original = normaliseData({ folders: [{ id: 'proofs', name: 'Proofs', createdAt: stamp }, { id: 'studio', name: 'Studio', createdAt: stamp }], projects: [{ id: 'first', name: 'First project', notes: 'Keep notes', folderId: 'proofs', createdAt: stamp }, { id: 'second', name: 'Second project', createdAt: stamp }], library: [{ id: 'saved', hex: '#C76B4A', name: 'Custom saved colour', tags: ['favourite', 'approved'], projectId: 'first', createdAt: stamp }], comparisons: [{ id: 'proof', name: 'Device proof', a: '#C76B4A', b: '#C86A4B', deviceDeltaE: 2.4, projectId: 'first', createdAt: stamp }] });
  const before = JSON.stringify(original);
  const stacked = moveProjectsToFolder(original, ['first', 'second'], 'studio');
  equal(stacked.projects.map(project => project.folderId), ['studio', 'studio'], 'Multiple projects can be grouped in a chosen folder.');
  equal(stacked.projects[0].notes, original.projects[0].notes, 'Moving a project retains its notes.');
  equal(stacked.library, original.library, 'Moving a project retains its palette, favourites and metadata.');
  equal(stacked.comparisons, original.comparisons, 'Moving a project retains its physical comparison metadata.');
  equal(JSON.stringify(original), before, 'Grouping does not mutate the original workspace.');
  const removed = removeProjectFolder(stacked, 'studio');
  equal(removed.folders.map(folder => folder.id), ['proofs'], 'Deleting a folder removes only that grouping.');
  equal(removed.projects.map(project => project.folderId), [undefined, undefined], 'Deleting a folder returns all its projects outside folders.');
  equal(removed.projects.length, 2, 'Deleting a folder never deletes projects.');
  equal(removed.library, original.library, 'Deleting a folder never deletes linked saved colours.');
  equal(removed.comparisons, original.comparisons, 'Deleting a folder never deletes linked saved comparisons.');
  equal(renameProjectFolder(original, 'proofs', '  Print proofs  ').folders[0].name, 'Print proofs', 'Folder names can be changed without changing IDs.');
  rejects(() => moveProjectsToFolder(original, ['first'], 'missing'), 'Stale folder selections are rejected before moving anything.');
  rejects(() => createProjectFolder('   ', 'empty'), 'Empty folder names are rejected.');
  rejects(() => renameProjectFolder(original, 'proofs', '  '), 'Empty folder renames are rejected.');
});

test('Folder backup imports preserve references and remap collisions safely', () => {
  const backup = { product: 'CHROMA', version: 2, folders: [{ id: 'a', name: 'Packaging', createdAt: stamp }], projects: [{ id: 'p', name: 'Print run', notes: 'Unchanged notes', folderId: 'a', createdAt: stamp }], colours: [{ id: 'c', hex: '#000075', name: 'Navy', projectId: 'p', createdAt: stamp }], comparisons: [] };
  const parsed = parseLibraryImport(backup);
  equal(parsed.folders, backup.folders, 'A standard backup retains folder names, IDs and dates.');
  equal(parsed.projects[0].folderId, 'a', 'A standard backup retains project membership.');
  const existing = [{ id: 'a', name: 'Living room', createdAt: stamp }, { id: 'other', name: 'Packaging', createdAt: stamp }];
  const merged = mergeProjectFolders(existing, parsed.folders, () => 'new-folder');
  equal(merged.folders, existing, 'Matching folder names merge instead of duplicating the existing folder.');
  equal(remapProjectFolder(parsed.projects[0], merged.folderMap).folderId, 'other', 'Imported membership follows the merged folder ID.');
  const collided = mergeProjectFolders(existing.slice(0, 1), parsed.folders, () => 'new-folder');
  equal(collided.folders.map(folder => folder.id), ['a', 'new-folder'], 'A conflicting folder ID gets a fresh ID without replacing the original folder.');
  equal(remapProjectFolder(parsed.projects[0], collided.folderMap).folderId, 'new-folder', 'Imported projects follow the collision-safe ID.');
  equal(parsed.library[0].projectId, parsed.projects[0].id, 'Folder imports do not change palette-to-project links.');
  const duplicateIds = normaliseData({ folders: [{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }], projects: [{ id: 'same', name: 'Project', folderId: 'same' }], library: [{ id: 'same', hex: '#123456', projectId: 'same' }] });
  equal(new Set([...duplicateIds.folders, ...duplicateIds.projects, ...duplicateIds.library].map(item => item.id)).size, 4, 'Folder/project/colour collisions are all remapped to unique IDs.');
  equal(duplicateIds.projects[0].folderId, duplicateIds.folders[0].id, 'Ambiguous old folder IDs consistently link to the first original.');
  equal(duplicateIds.library[0].projectId, duplicateIds.projects[0].id, 'Colliding old project IDs still preserve palette links.');
  const dangling = normaliseData({ folders: [], projects: [{ id: 'keep', name: 'Keep me', folderId: 'gone', createdAt: stamp }] });
  equal(dangling.projects[0].folderId, undefined, 'A missing folder recovers the project outside folders.');
  equal(dangling.projects[0].name, 'Keep me', 'A missing folder never loses the project.');
  for (const folders of [null, {}, [null], [{ name: '' }]]) rejects(() => parseLibraryImport({ colours: [], folders }), 'Invalid imported folders reject the whole import instead of silently losing grouping data.');
});

test('BLE comparison and clear-channel persistence', () => {
  const record = { id: 'device-comparison', a: '#E0354D', b: '#DC3750', name: 'ESP32 measurement', deviceDeltaE: 2.4 };
  const data = normaliseData({ latest: { hex: '#E0354D', source: 'bluetooth', clear: 630 }, comparisons: [record] });
  equal(data.latest.clear, 630, 'The scan clear channel survives normalization.');
  equal(data.latest.source, 'bluetooth', 'A saved BLE reading retains physical provenance.');
  equal(data.comparisons[0].deviceDeltaE, 2.4, 'Normalization retains the device-provided Delta E.');
  const reloaded = loadWorkspace(fakeStorage({ [STORAGE_KEY]: JSON.stringify(data) }));
  equal(reloaded.comparisons[0].deviceDeltaE, 2.4, 'Reload retains the device-provided value.');
  equal(reloaded.latest.clear, 630, 'Reload retains clear.');
  const imported = parseLibraryImport({ colours: [], comparisons: [record, { ...record, id: 'zero', deviceDeltaE: 0 }] });
  equal(imported.comparisons.map(item => item.deviceDeltaE), [2.4, 0], 'JSON imports preserve measured values including zero.');
  for (const bad of [-1, Infinity, NaN, '2.4']) {
    equal(normaliseData({ comparisons: [{ ...record, deviceDeltaE: bad }] }).comparisons[0].deviceDeltaE, undefined, 'Invalid stored measurement metadata is discarded safely.');
  }
  equal(normaliseData({ comparisons: [{ a: '#000000', b: '#FFFFFF' }] }).comparisons[0].deviceDeltaE, undefined, 'Legacy comparisons still use app-computed Delta E.');
});

test('Independent comparison sources survive reload and backup import', () => {
  const records = [
    { id: 'captured-reference', a: '#E0354D', b: '#123456', name: 'Capture and wheel', createdAt: stamp, referenceSource: 'bluetooth', sampleSource: 'manual' },
    { id: 'library-reference', a: '#123456', b: '#DC3750', name: 'Library and scan', createdAt: stamp, referenceSource: 'library', sampleSource: 'demo', matchTarget: { source: 'library', name: 'Reference colour', libraryItemId: 'saved-reference' } },
    { id: 'legacy-pair', a: '#000000', b: '#FFFFFF', name: 'Earlier comparison', createdAt: stamp },
  ];
  const data = normaliseData({ comparisons: records });
  equal(data.comparisons[0].referenceSource, 'bluetooth', 'A captured reference retains its physical provenance when the sample is digital.');
  equal(data.comparisons[0].sampleSource, 'manual', 'Reference provenance cannot overwrite the independently chosen sample source.');
  equal(data.comparisons[1].referenceSource, 'library', 'A library reference retains its source alongside match-target metadata.');
  equal(data.comparisons[1].matchTarget?.libraryItemId, 'saved-reference', 'The reference keeps its existing library metadata.');
  equal(data.comparisons[2].referenceSource, undefined, 'Older comparisons load without an invented reference source.');
  const restored = loadWorkspace(fakeStorage({ [STORAGE_KEY]: JSON.stringify(data) }));
  equal(restored.comparisons, data.comparisons, 'Both comparison sources survive a cold workspace reload.');
  const imported = parseLibraryImport({ colours: [], comparisons: records });
  equal(imported.comparisons.map(item => [item.referenceSource, item.sampleSource]), [['bluetooth', 'manual'], ['library', 'demo'], [undefined, undefined]], 'JSON backup imports preserve source combinations and remain compatible with older records.');
  for (const invalid of [null, 123, {}, []]) {
    equal(normaliseData({ comparisons: [{ ...records[0], referenceSource: invalid }] }).comparisons[0].referenceSource, undefined, 'Malformed optional reference provenance is safely ignored.');
  }
});

test('Partial legacy records and malformed optional containers', () => {
  const data = normaliseData({
    library: { unexpected: true },
    colours: [{ id: 'rgb-only', rgb: { r: 18, g: 52, b: 86 }, name: 'Old RGB sample', favorite: true, timestamp: stamp, source: 'usb', clear: 101, projectId: 'project-old' }],
    projects: [null, false, { id: 'project-old', name: 'Old proofs' }],
    history: null, comparisons: 'old value', latest: null,
  });
  equal(data.library.length, 1, 'A malformed library container does not hide the valid legacy colours array.');
  equal(data.library[0].hex, '#123456', 'Valid RGB-only legacy colours are recovered.');
  equal(data.library[0].tags, ['favourite'], 'The legacy American-spelled boolean favourite is retained as a tag.');
  equal(data.library[0].id, 'rgb-only', 'A valid legacy ID survives.');
  equal(data.library[0].createdAt, stamp, 'A valid legacy timestamp survives.');
  equal(data.library[0].clear, 101, 'Device metadata survives legacy recovery.');
  equal(data.library[0].source, 'usb', 'Device provenance survives legacy recovery.');
  equal(data.library[0].projectId, 'project-old', 'A valid legacy project link survives.');
  equal(data.projects.length, 1, 'Null and primitive projects do not become phantom projects.');
  equal(data.projects[0].notes, '', 'Missing project notes receive a safe default.');
  equal([data.history.length, data.comparisons.length], [0, 0], 'Malformed optional containers become safe arrays.');
  check(Array.isArray(data.latest.tags), 'Missing latest colour receives render-safe defaults.');
  equal(normaliseData({ library: [], colours: [{ hex: '#fff' }] }).library, [], 'An explicit empty current library remains authoritative.');
  equal(parseLibraryImport({ colours: 'invalid optional alias', library: [{ hex: '#abc' }] }).library[0].hex, '#AABBCC', 'Imports count the actual selected array rather than a truthy malformed alias.');
  const favourites = normaliseData({ library: [{ hex: '#abc', favourite: true, tags: ['approved'] }, { hex: '#def', favorite: true, tags: ['Favorite'] }] });
  equal(favourites.library[0].tags, ['favourite', 'approved'], 'British-spelled favourites retain existing tags.');
  equal(favourites.library[1].tags, ['Favorite'], 'Existing favourite tags are not duplicated.');
  equal(normaliseData({ library: [{ rgb: { r: -1, g: 20, b: 30 } }, { rgb: { r: 1.5, g: 20, b: 30 } }, { rgb: { r: 1, g: 20 } }] }).library, [], 'Invalid RGB values are not guessed or clamped into saved colours.');
});

test('Persisted canonical colours discard stale derived values', () => {
  const diagnostics: PersistedColourDiagnostic[] = [];
  const report = (diagnostic: PersistedColourDiagnostic) => diagnostics.push(diagnostic);
  const stale = { id: 'old-blue', name: 'Saved blue', hex: '#000009', rgb: { r: 255, g: 0, b: 0 }, hsl: { h: '240', s: 'invalid private text', l: Infinity }, lab: { l: NaN }, notes: 'Never log this note', tags: ['Private tag'] };
  const result = normalisePersistedColour(stale, 'library[7]', report);
  equal(result, colorInfo('#000009'), 'Valid HEX is authoritative and every derived colour model is recomputed.');
  check(result && [result.hsl.h, result.hsl.s, result.hsl.l].every(Number.isFinite), 'Canonical derived HSL is always finite.');
  check(result && result.hsl.s <= 100, 'A very dark saturated colour receives bounded derived saturation.');
  equal(diagnostics[0], { context: 'library[7]', id: 'old-blue', name: 'Saved blue', source: 'hex', reasons: ['invalid-stored-hsl'], hsl: { h: 240 } }, 'Recovery identifies the source record and reports only finite colour fields.');
  check(!JSON.stringify(diagnostics).includes('private') && !JSON.stringify(diagnostics).includes('Private') && !JSON.stringify(diagnostics).includes('note'), 'Diagnostics omit raw colour strings, notes and tags.');
  equal(normalisePersistedColour({ hex: '#123456' }, 'latest', report), colorInfo('#123456'), 'A record without derived HSL requires no guessed defaults.');
  equal(diagnostics.length, 1, 'Absent derived HSL does not produce warnings.');
  equal(normalisePersistedColour({ hex: 'invalid', rgb: { r: '18', g: '52', b: '86' }, hsl: { h: 0, s: 100, l: 50 } }, 'history[0]', report)?.hex, '#123456', 'Valid legacy RGB is preferred over HSL even when stored HEX is malformed.');
  equal(diagnostics[1].source, 'rgb', 'A canonical fallback is diagnosed.');
  equal(normalisePersistedColour(stale, 'latest', () => { throw new Error('Diagnostic sink failed'); })?.hex, '#000009', 'A diagnostic sink cannot make a renderable colour fail.');
});

test('Exact Navy scan and all stale saturation representations', () => {
  for (const saturation of [undefined, null, NaN, Infinity, '45%', '45', 150, -20, 0]) {
    const input = { id: 'navy-scan', name: 'Navy', hex: '#000075', rgb: { r: 0, g: 0, b: 117 }, hsl: { h: 240, s: saturation, l: 23 }, clear: 630 };
    const result = normalisePersistedColour(input, 'latest', () => {});
    equal(result?.hex, '#000075', 'Malformed or stale derived HSL never changes the actual saved Navy reading.');
    equal(result?.hsl, { h: 240, s: 100, l: 117 / 255 / 2 * 100 }, 'Navy derives a finite, exactly bounded saturation from canonical RGB.');
    equal(input.hsl.s, saturation, 'Compatibility recovery leaves each original field untouched.');
  }
  for (const hex of ['#000000', '#FFFFFF']) equal(normalisePersistedColour({ hex }, 'achromatic', () => {})?.hsl.s, 0, 'Black/white preserve zero saturation.');
});

test('Colour render failures include bounded identifying context', () => {
  const original = console.error;
  const messages: string[] = [];
  const reading = { id: 'navy-scan', name: 'Navy', hex: '#000075', notes: 'Private project notes' };
  try {
    console.error = message => { messages.push(String(message)); };
    rejects(() => withColourRenderContext(reading, 'ScanPage.similarColours', () => { throw new Error('Colour diagnostic test'); }), 'The boundary still receives the underlying colour error.');
  } finally { console.error = original; }
  check(messages[0].includes('ScanPage.similarColours') && messages[0].includes('navy-scan') && messages[0].includes('Navy') && messages[0].includes('#000075'), 'The actual render context and colour identity are logged.');
  check(!messages[0].includes('Private project notes'), 'Unrelated saved metadata is never dumped into diagnostics.');
});

test('Legacy HSL representations normalize only at the saved-data boundary', () => {
  const diagnostics: PersistedColourDiagnostic[] = [];
  const cases: Array<[unknown, string]> = [
    [{ hsl: { h: '120', s: '100%', l: '50%' } }, '#00FF00'],
    [{ hsl: 'hsl(240, 100%, 50%)' }, '#0000FF'],
    ['hsl(0 100% 50%)', '#FF0000'],
    [{ hsl: '240, 100%, 50%' }, '#0000FF'],
    [{ h: '120deg', s: '100', l: '50' }, '#00FF00'],
    [{ hsl: { h: -120, s: 130, l: 50 } }, '#0000FF'],
    [{ hsl: { h: 360, s: -10, l: 150 } }, '#FFFFFF'],
  ];
  for (const [input, expected] of cases) {
    const original = JSON.stringify(input);
    equal(normalisePersistedColour(input, 'legacy fixture', value => diagnostics.push(value))?.hex, expected, 'Finite legacy HSL components become a render-safe canonical colour.');
    equal(JSON.stringify(input), original, 'Recovering legacy HSL never mutates the original record.');
  }
  check(diagnostics.some(diagnostic => diagnostic.reasons.includes('repaired-legacy-hsl-range')), 'Wrapping or clamping legacy HSL is explicitly diagnosed.');
  const invalid = [null, false, {}, { hsl: { h: 120, s: undefined, l: 50 } }, { hsl: { h: Infinity, s: 100, l: 50 } }, { hsl: { h: 'NaN', s: 100, l: 50 } }, { hsl: { h: 120, s: '', l: 50 } }, { hsl: { h: 120, s: '100%%', l: 50 } }, { hsl: 'hsl(120, missing, 50%)' }];
  for (const input of invalid) equal(normalisePersistedColour(input, 'invalid fixture', value => diagnostics.push(value)), null, 'Missing or non-finite legacy components remain quarantined rather than creating fake colours.');
  check(diagnostics.at(-1)?.reasons.includes('quarantined-original-retained'), 'An unrecoverable record has an explicit diagnosis.');
  rejects(() => hslToRgb({ h: 120, s: 101, l: 50 }), 'Manual HSL conversion still rejects out-of-range saturation.');
  rejects(() => parseColor('120, 101%, 50%', 'HSL'), 'Convert parsing does not inherit storage compatibility repairs.');
});

test('Mixed legacy HSL records recover independently and preserve exact originals', () => {
  const raw = JSON.stringify({
    version: 1,
    latest: { id: 'latest-hsl', hsl: { h: '120', s: '100%', l: '50%' }, name: 'Green scan', timestamp: stamp, source: 'bluetooth', clear: 123 },
    library: [{ id: 'canonical', hex: '#abc', hsl: { h: 210, s: 'bad', l: 75 }, name: 'Canonical sample' }, { id: 'bad-hsl', hsl: { h: 0, l: 50 }, notes: 'Keep the exact malformed original' }, { id: 'old-hsl', hsl: 'hsl(240,100%,50%)', favorite: true, name: 'Old blue', timestamp: stamp, source: 'usb' }],
    history: [{ id: 'history-hsl', hsl: { h: -120, s: '100%', l: '50%' }, name: 'Old history', timestamp: stamp }],
    comparisons: [{ id: 'comparison-hsl', a: { hsl: 'hsl(0 100% 50%)' }, b: { rgb: { r: 0, g: 255, b: 0 } }, name: 'Old proof', timestamp: stamp }],
  });
  const store = writableStorage({ [STORAGE_KEY]: raw });
  const loaded = loadWorkspaceState(store);
  equal(loaded.workspace.latest.hex, '#00FF00', 'Latest legacy HSL recovers before the Scan page reads it.');
  equal(loaded.workspace.latest.clear, 123, 'Canonicalization preserves sensor metadata.');
  equal(loaded.workspace.library.map(colour => colour.id), ['canonical', 'old-hsl'], 'A malformed record does not hide valid neighboring colours.');
  equal(loaded.workspace.library[1].tags, ['favourite'], 'Legacy favourites survive HSL recovery.');
  equal(loaded.workspace.library[1].createdAt, stamp, 'Legacy dates survive HSL recovery.');
  equal(loaded.workspace.library[1].source, 'usb', 'Legacy provenance survives HSL recovery.');
  equal(loaded.workspace.history[0].hex, '#0000FF', 'History uses the same safe compatibility boundary.');
  equal([loaded.workspace.comparisons[0].a, loaded.workspace.comparisons[0].b], ['#FF0000', '#00FF00'], 'Both comparison representations use the central compatibility boundary.');
  equal(store.writes, [], 'Loading mixed legacy colour data never writes or migrates the original in place.');
  equal(persistWorkspace(loaded, loaded.workspace).status, 'unchanged', 'Mounting recovered HSL does not rewrite storage.');
  equal(store.getItem(STORAGE_KEY), raw, 'The full raw original still includes the quarantined record.');
  equal(persistWorkspace(loaded, { ...loaded.workspace, library: loaded.workspace.library.map(colour => ({ ...colour, name: `${colour.name} edited` })) }).status, 'saved', 'A later user edit can save recovered colours after backup.');
  equal(store.getItem(loaded.preservation[0].backupKey!), raw, 'The verified backup retains malformed HSL, old representations and metadata byte-for-byte.');
});

test('Non-destructive hydration and verified raw recovery copies', () => {
  const raw = JSON.stringify({ version: 1, library: [{ id: 'keep', hex: '#abc', favourite: true, customMetadata: { measured: 'once' } }, { unknownColourFormat: 'future colour' }], extraWorkspaceField: { keep: true } });
  const store = writableStorage({ [STORAGE_KEY]: raw });
  const loaded = loadWorkspaceState(store);
  equal(loaded.status, 'recovered', 'Partial old data is reported as recovered.');
  equal(store.writes, [], 'Hydration never writes to storage.');
  equal(persistWorkspace(loaded, loaded.workspace).status, 'unchanged', 'The initial normalized workspace is never automatically rewritten.');
  equal(persistWorkspace(loaded, { ...loaded.workspace }).status, 'unchanged', 'Equivalent rerenders and StrictMode effect replay do not rewrite originals.');
  equal(store.getItem(STORAGE_KEY), raw, 'The untouched raw input is still the saved workspace after mounting.');
  const changed = { ...loaded.workspace, library: loaded.workspace.library.map(colour => ({ ...colour, name: 'Renamed' })) };
  equal(persistWorkspace(loaded, changed).status, 'saved', 'A later edit can be saved after preserving the exact original.');
  const backup = loaded.preservation[0];
  check(backup.backupKey, 'The load state reports the recovery copy location.');
  equal(store.getItem(backup.backupKey!), raw, 'The copy retains exact raw JSON, unknown fields and unrecognized records.');
  equal(store.writes[0], { key: backup.backupKey, value: raw }, 'The raw backup is written before the normalized replacement.');
  equal(JSON.parse(store.getItem(STORAGE_KEY)!).library[0].tags, ['favourite'], 'The saved usable record keeps its recovered favourite state.');
  equal(persistWorkspace(loaded, changed).status, 'unchanged', 'An identical subsequent render does not persist again.');
});

test('Corrupt current data with an intact legacy fallback', () => {
  const broken = '{broken JSON with original data';
  const older = JSON.stringify(legacy);
  const store = writableStorage({ [STORAGE_KEY]: broken, 'chroma-workspace-v1': older });
  const loaded = loadWorkspaceState(() => store);
  equal(loaded.workspace.library[0].name, 'Custom pale blue', 'Safe hydration uses an intact legacy fallback.');
  equal(store.writes, [], 'Fallback hydration leaves both originals untouched.');
  equal(persistWorkspace(loaded, loaded.workspace).status, 'unchanged', 'Fallback does not overwrite the corrupt current snapshot on mount.');
  equal(persistWorkspace(loaded, { ...loaded.workspace, library: [] }).status, 'saved', 'A changed fallback workspace is persisted only after preservation.');
  equal(loaded.preservation.map(snapshot => store.getItem(snapshot.backupKey!)), [broken, older], 'Both exact current and legacy originals receive recovery copies.');
  equal(store.getItem('chroma-workspace-v1'), older, 'The legacy source is never changed or removed.');
  for (const raw of ['null', '[]', '42', '"old string"', '{"unrecognized":"original"}', '']) {
    const invalid = writableStorage({ [STORAGE_KEY]: raw });
    const fallback = loadWorkspaceState(invalid);
    equal(fallback.status, 'recovered', 'Unrecognized JSON is surfaced as recovery rather than a fresh store.');
    check(fallback.warning, 'Fallback informs the user that existing data needed recovery.');
    equal(persistWorkspace(fallback, fallback.workspace).status, 'unchanged', 'Invalid top-level JSON is not replaced at startup.');
    equal(invalid.getItem(STORAGE_KEY), raw, 'The exact invalid original remains recoverable.');
  }
});

test('Storage access and backup failures cannot overwrite originals', () => {
  const denied = loadWorkspaceState(() => { throw new Error('SecurityError'); });
  equal(denied.status, 'unavailable', 'Throwing localStorage property access is caught during acquisition.');
  check(denied.workspace.library.length > 0, 'A storage getter failure still allows the UI to render.');
  equal(persistWorkspace(denied, denied.workspace).status, 'blocked', 'Unavailable storage never triggers a persistence attempt.');
  const readDenied = loadWorkspaceState({ getItem: () => { throw new Error('SecurityError'); } });
  equal(readDenied.status, 'unavailable', 'Throwing getItem is also reported without a startup crash.');
  const raw = JSON.stringify({ library: [{ hex: '#abc' }] });
  const store = writableStorage({ [STORAGE_KEY]: raw });
  const brokenBackupStore = { getItem: store.getItem, setItem: (key: string, value: string) => { if (key !== STORAGE_KEY) throw new Error('QuotaExceededError'); store.setItem(key, value); } };
  const loaded = loadWorkspaceState(brokenBackupStore);
  equal(persistWorkspace(loaded, { ...loaded.workspace, library: [] }).status, 'blocked', 'A failed backup blocks replacement.');
  equal(store.getItem(STORAGE_KEY), raw, 'Backup failure never overwrites the existing raw snapshot.');
  equal(store.writes, [], 'No workspace write is attempted after backup failure.');
  const silent = loadWorkspaceState({ getItem: store.getItem, setItem: () => {} });
  equal(persistWorkspace(silent, { ...silent.workspace, library: [] }).status, 'blocked', 'A backup must be read back exactly, not merely accepted by setItem.');
  equal(store.getItem(STORAGE_KEY), raw, 'An unverified backup cannot permit replacing the original.');
});

test('Future versions, external changes and new stores', () => {
  const raw = JSON.stringify({ version: 3, library: [{ hex: '#123456', futureField: 'retained' }] });
  const futureStore = writableStorage({ [STORAGE_KEY]: raw });
  const future = loadWorkspaceState(futureStore);
  equal(future.status, 'unsupported', 'A future schema is explicitly recognized.');
  equal(future.workspace.library[0].hex, '#123456', 'Readable colours in a future schema can still render.');
  equal(persistWorkspace(future, { ...future.workspace, library: [] }).status, 'blocked', 'An older app cannot downgrade a newer schema.');
  equal(futureStore.writes, [], 'The newer workspace is left exactly untouched.');
  const store = writableStorage({ [STORAGE_KEY]: JSON.stringify(seedWorkspace()) });
  const loaded = loadWorkspaceState(store);
  store.values[STORAGE_KEY] = '{"changed":"by another tab"}';
  equal(persistWorkspace(loaded, { ...loaded.workspace, library: [] }).status, 'blocked', 'Another session changing the snapshot blocks stale replacement.');
  equal(store.writes, [], 'A stale session performs no writes.');
  const freshStore = writableStorage();
  const fresh = loadWorkspaceState(freshStore);
  equal(fresh.status, 'seeded', 'An empty store is distinguished from recovery.');
  equal(freshStore.writes, [], 'Even a fresh store is not written during hydration.');
  equal(persistWorkspace(fresh, fresh.workspace).status, 'saved', 'The initial seed can be persisted when there are no originals to protect.');
  equal(freshStore.writes.length, 1, 'A fresh store needs only the workspace write.');
});

test('Canonical edits do not accumulate recovery backups across launches', () => {
  const store = writableStorage({ [STORAGE_KEY]: JSON.stringify(seedWorkspace()) });
  for (let launch = 0; launch < 3; launch++) {
    const loaded = loadWorkspaceState(store);
    equal(loaded.status, 'ready', 'A canonical saved workspace needs no migration.');
    const changed = { ...loaded.workspace, library: loaded.workspace.library.map((colour, index) => index === 0 ? { ...colour, name: `Edit ${launch}` } : colour) };
    equal(persistWorkspace(loaded, changed).status, 'saved', 'Canonical edits still save across cold launches.');
  }
  equal(Object.keys(store.values), [STORAGE_KEY], 'Routine edits across launches do not create growing recovery copies.');
  equal(store.writes.length, 3, 'Only the three changed workspace snapshots are written.');
});

test('Identical recovery originals reuse exact backups without overwriting collisions', () => {
  const raw = '{broken current JSON';
  const older = JSON.stringify(legacy);
  const store = writableStorage({ [STORAGE_KEY]: raw, 'chroma-workspace-v1': older });
  const first = loadWorkspaceState(store);
  equal(persistWorkspace(first, { ...first.workspace, library: [] }).status, 'saved', 'The first fallback edit creates required recovery copies.');
  const firstKeys = first.preservation.map(snapshot => snapshot.backupKey!);
  // Simulate encountering the same source snapshots on another launch.
  store.values[STORAGE_KEY] = raw;
  const second = loadWorkspaceState(store);
  const writesBefore = store.writes.length;
  equal(persistWorkspace(second, { ...second.workspace, library: [] }).status, 'saved', 'An identical recovered source can be saved again.');
  equal(second.preservation.map(snapshot => snapshot.backupKey), firstKeys, 'Both exact malformed and legacy originals reuse their previous recovery keys.');
  equal(store.writes.length - writesBefore, 1, 'Backup reuse writes only the changed workspace.');
  equal(firstKeys.map(key => store.getItem(key)), [raw, older], 'Reused copies retain both exact original strings.');
  const collisionStore = writableStorage({ [STORAGE_KEY]: raw, 'chroma-workspace-v1': older, [firstKeys[0]]: 'A different original at the same fingerprint' });
  const collided = loadWorkspaceState(collisionStore);
  equal(persistWorkspace(collided, { ...collided.workspace, library: [] }).status, 'saved', 'A fingerprint collision can use another safe backup key.');
  equal(collided.preservation[0].backupKey, `${firstKeys[0]}-1`, 'A differing raw value gets a collision suffix.');
  equal(collisionStore.getItem(firstKeys[0]), 'A different original at the same fingerprint', 'An existing recovery copy is never overwritten.');
  equal(collisionStore.getItem(collided.preservation[0].backupKey!), raw, 'The collision-suffixed backup retains the exact new original.');
});

test('Silent workspace write failures are never reported as saved', () => {
  const raw = JSON.stringify({ library: [{ hex: '#abc', unknownMetadata: 'original' }] });
  const store = writableStorage({ [STORAGE_KEY]: raw });
  let discardWorkspaceWrites = true;
  const unreliable = { getItem: store.getItem, setItem: (key: string, value: string) => { if (key === STORAGE_KEY && discardWorkspaceWrites) return; store.setItem(key, value); } };
  const loaded = loadWorkspaceState(unreliable);
  const changed = { ...loaded.workspace, library: [] };
  equal(persistWorkspace(loaded, changed).status, 'blocked', 'A silent no-op workspace write fails read-back verification.');
  equal(store.getItem(STORAGE_KEY), raw, 'The unsaved original remains unchanged.');
  equal(persistWorkspace(loaded, changed).status, 'blocked', 'A failed write cannot advance the cached snapshot to unchanged.');
  equal(store.getItem(loaded.preservation[0].backupKey!), raw, 'The exact recovery copy is retained despite a failed final write.');
  discardWorkspaceWrites = false;
  equal(persistWorkspace(loaded, changed).status, 'saved', 'The same edit can be retried once writes work.');
  equal(JSON.parse(store.getItem(STORAGE_KEY)!).library, [], 'A reported successful retry actually reached storage.');
  const empty = loadWorkspaceState({ getItem: () => null, setItem: () => {} });
  equal(persistWorkspace(empty, empty.workspace).status, 'blocked', 'A silent initial seed write is also reported as failed.');
});

if (failures.length) {
  console.error(failures.join('\n'));
  throw new Error(`${failures.length} workspace test groups failed after ${checks} checks.`);
}
console.log(`${checks} workspace storage checks passed.`);
