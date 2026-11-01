import { colorInfo } from '../lib/color';
import { normalisePersistedColour } from '../lib/persistedColour';
import { remapMatchTargetMetadata } from '../lib/imageMatch';
import type { ColourRecord, ComparisonRecord, Project, ProjectFolder, WorkspaceData } from '../types';

export const STORAGE_KEY = 'chroma-workspace-v2';
const LEGACY_STORAGE_KEY = 'chroma-workspace-v1';
export const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const text = (value: unknown, fallback = '', max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const colourList = (data: Record<string, unknown>) => Array.isArray(data.library) ? data.library : list(data.colours);

export function normaliseData(input: unknown, includeSampleProject = false): WorkspaceData {
  const data = object(input);
  const ids = new Set<string>();
  const projectIds = new Map<string, string>();
  const folderIds = new Map<string, string>();
  const libraryIds = new Map<string, string>();
  const uniqueId = (value: unknown) => { let id = text(value); if (!id || ids.has(id)) id = uid(); ids.add(id); return id; };
  const folders: ProjectFolder[] = list(data.folders).filter(value => value !== null && typeof value === 'object' && !Array.isArray(value)).map(value => {
    const folder = object(value);
    const id = uniqueId(folder.id), originalId = text(folder.id);
    if (originalId && !folderIds.has(originalId)) folderIds.set(originalId, id);
    return { id, name: text(folder.name, 'Untitled folder', 80) || 'Untitled folder', createdAt: date(folder.createdAt || folder.timestamp) };
  });
  const projects: Project[] = list(data.projects).filter(value => value !== null && typeof value === 'object' && !Array.isArray(value)).map(value => {
    const project = object(value);
    const id = uniqueId(project.id), originalId = text(project.id);
    if (originalId && !projectIds.has(originalId)) projectIds.set(originalId, id);
    const folderId = folderIds.get(text(project.folderId));
    return { id, name: text(project.name, 'Untitled project', 80) || 'Untitled project', notes: text(project.notes, '', 5000), createdAt: date(project.createdAt || project.timestamp), ...(folderId ? { folderId } : {}) };
  });
  function projectFor(item: Record<string, unknown>) {
    const original = text(item.projectId);
    const explicit = projectIds.get(original) ?? original;
    if (explicit && projects.some(project => project.id === explicit)) return explicit;
    const legacyName = text(item.project, '', 80);
    if (!legacyName) return undefined;
    let project = projects.find(p => p.name === legacyName);
    if (!project) { project = { id: uniqueId(undefined), name: legacyName, notes: '', createdAt: new Date().toISOString() }; projects.push(project); }
    return project.id;
  }
  function colour(value: unknown, context: string): ColourRecord | null {
    const item = object(value);
    try {
      const info = normalisePersistedColour(value, context);
      if (!info) return null;
      const tags = [...new Set(list(item.tags).filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim().slice(0, 30)).filter(Boolean))];
      if ((item.favourite === true || item.favorite === true) && !tags.some(tag => ['favourite', 'favorite'].includes(tag.toLowerCase()))) tags.unshift('favourite');
      return { id: uniqueId(item.id), hex: info.hex, name: text(item.name, info.name, 80) || info.name, rgb: info.rgb,
        tags: tags.slice(0, 15),
        createdAt: date(item.createdAt || item.timestamp), source: text(item.source, 'imported', 30), projectId: projectFor(item),
        ...(typeof item.clear === 'number' && Number.isSafeInteger(item.clear) && item.clear >= 0 ? { clear: item.clear } : {}) };
    } catch { return null; }
  }
  const library = colourList(data).flatMap((value, index) => {
    const record = colour(value, `library[${index}]`);
    if (!record) return [];
    const originalId = text(object(value).id);
    if (originalId && !libraryIds.has(originalId)) libraryIds.set(originalId, record.id);
    return [record];
  });
  const history = list(data.history).map((value, index) => colour(value, `history[${index}]`)).filter((item): item is ColourRecord => item !== null);
  const comparisons: ComparisonRecord[] = list(data.comparisons).flatMap((value, index) => {
    const item = object(value);
    const matchTarget = remapMatchTargetMetadata(item.matchTarget, libraryIds, projectIds);
    try {
      const a = normalisePersistedColour(item.a, `comparisons[${index}].a`), b = normalisePersistedColour(item.b, `comparisons[${index}].b`);
      if (!a || !b) return [];
      return [{ id: uniqueId(item.id), a: a.hex, b: b.hex, name: text(item.name, 'Colour comparison', 100) || 'Colour comparison', createdAt: date(item.createdAt || item.timestamp), projectId: projectFor(item),
      ...(matchTarget ? { matchTarget } : {}),
      ...(text(item.sampleSource, '', 30) ? { sampleSource: text(item.sampleSource, '', 30) } : {}),
      ...(text(item.referenceSource, '', 30) ? { referenceSource: text(item.referenceSource, '', 30) } : {}),
      ...(typeof item.deviceDeltaE === 'number' && Number.isFinite(item.deviceDeltaE) && item.deviceDeltaE >= 0 ? { deviceDeltaE: item.deviceDeltaE } : {}) }]; }
    catch { return []; }
  });
  let latest = data.latest == null ? null : colour(data.latest, 'latest');
  if (!latest) latest = { id: uid(), hex: '#C76B4A', name: 'Terracotta', rgb: colorInfo('#C76B4A').rgb, tags: [], source: 'sample', createdAt: new Date().toISOString() };
  if (includeSampleProject && !projects.some(p => p.name === 'Summer Packaging')) {
    projects.unshift({ id: uid(), name: 'Summer Packaging', notes: 'A warm, natural palette for a summer packaging concept. Compare printed samples with the saved reference colours in consistent lighting.', createdAt: new Date().toISOString() });
  }
  return { version: 2, latest, history, library, comparisons, projects, folders };
}

export function seedWorkspace(): WorkspaceData {
  const now = new Date().toISOString();
  const samples = [
    ['Terracotta', '#C76B4A', 'warm'], ['Deep Blue', '#274C77', 'cool'], ['Warm Sand', '#E8D3AA', 'neutral'],
    ['Forest Green', '#355E4B', 'nature'], ['Soft Beige', '#E6DDCE', 'neutral'], ['Charcoal', '#303633', 'neutral'],
  ];
  const library = samples.map(([name, hex, tag], i) => ({ id: `sample-colour-${i}`, name, hex, tags: [tag, 'sample'], source: 'sample', createdAt: now, projectId: i < 3 ? 'summer-packaging' : undefined }));
  return normaliseData({
    projects: [{ id: 'summer-packaging', name: 'Summer Packaging', notes: 'A tactile palette for a small-batch summer collection.\n\nTerracotta for the main sleeve, warm sand for the label, and deep blue for a precise typographic accent. Compare each physical proof to its digital reference before choosing.', createdAt: now }],
    library, history: library.slice(0, 4), latest: library[0],
    comparisons: [{ id: 'summer-comparison', a: '#C76B4A', b: '#C86A4B', name: 'Terracotta · first print proof', projectId: 'summer-packaging', createdAt: now }],
  });
}

type WorkspaceStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>;
type WorkspaceStorageSource = WorkspaceStorage | (() => WorkspaceStorage);
export interface WorkspaceSnapshot { key: string; raw: string; backupKey?: string }
export interface WorkspaceLoadState {
  workspace: WorkspaceData;
  status: 'ready' | 'recovered' | 'seeded' | 'unavailable' | 'unsupported';
  warning?: string;
  /** Recovery originals remain at their source keys until a verified backup permits a later save. */
  preservation: WorkspaceSnapshot[];
}
export interface WorkspaceSaveResult { status: 'saved' | 'unchanged' | 'blocked'; warning?: string }
interface PersistenceSession {
  storage?: WorkspaceStorage;
  serialized?: string;
  expectedCurrent: string | null;
  blocked?: string;
}
const sessions = new WeakMap<WorkspaceLoadState, PersistenceSession>();
const unavailableWarning = 'Browser storage is unavailable or full. Export your library to keep a copy.';

// The fingerprint only locates a candidate: exact raw equality is always checked before reuse.
function recoveryKey(snapshot: WorkspaceSnapshot): string {
  let hash = 2166136261;
  for (let index = 0; index < snapshot.raw.length; index++) hash = Math.imul(hash ^ snapshot.raw.charCodeAt(index), 16777619) >>> 0;
  return `${snapshot.key}:recovery:${snapshot.raw.length.toString(36)}-${hash.toString(36)}`;
}

/** Read without writing, including when the browser's localStorage property itself throws. */
export function loadWorkspaceState(source: WorkspaceStorageSource = () => globalThis.localStorage): WorkspaceLoadState {
  const preservation: WorkspaceSnapshot[] = [];
  let storage: WorkspaceStorage | undefined;
  let readFailed = false;
  try { storage = typeof source === 'function' ? source() : source; }
  catch { readFailed = true; }
  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    if (!storage) break;
    try {
      const raw = storage.getItem(key);
      if (raw !== null) preservation.push({ key, raw });
    } catch { readFailed = true; }
  }
  let workspace: WorkspaceData | undefined;
  let status: WorkspaceLoadState['status'] = 'seeded';
  let futureVersion = false;
  for (const snapshot of preservation) {
    try {
      const parsed: unknown = JSON.parse(snapshot.raw);
      const data = object(parsed);
      const future = typeof data.version === 'number' && data.version > 2;
      futureVersion ||= future;
      // A primitive or unrelated JSON document is not an intentionally empty workspace.
      if (!['latest', 'library', 'colours', 'history', 'projects', 'comparisons', 'folders'].some(key => Object.prototype.hasOwnProperty.call(data, key))) continue;
      workspace = normaliseData(data, snapshot.key === LEGACY_STORAGE_KEY);
      status = future ? 'unsupported' : snapshot.key === STORAGE_KEY && JSON.stringify(workspace) === JSON.stringify(parsed) ? 'ready' : 'recovered';
      break;
    } catch { /* Try an intact older snapshot; retain this original for recovery. */ }
  }
  if (!workspace) {
    workspace = seedWorkspace();
    if (preservation.length) status = 'recovered';
  }
  let warning: string | undefined;
  if (futureVersion) {
    status = 'unsupported';
    warning = 'This workspace was saved by a newer CHROMA version. The original is preserved; saving is paused to protect it.';
  } else if (readFailed || !storage) {
    status = 'unavailable';
    warning = unavailableWarning;
  } else if (status === 'recovered') {
    warning = 'Saved workspace data needed recovery. The original is preserved and will be backed up before any changes are saved.';
  }
  const state: WorkspaceLoadState = { workspace, status, warning, preservation };
  sessions.set(state, {
    storage,
    // New installations can persist their samples. Existing snapshots are never rewritten on mount.
    serialized: preservation.length ? JSON.stringify(workspace) : undefined,
    expectedCurrent: preservation.find(snapshot => snapshot.key === STORAGE_KEY)?.raw ?? null,
    blocked: futureVersion || readFailed || !storage ? warning : undefined,
  });
  return state;
}

/** Save recovered data only after every loaded original has a verified, exact recovery copy. */
export function persistWorkspace(state: WorkspaceLoadState, workspace: WorkspaceData): WorkspaceSaveResult {
  const session = sessions.get(state);
  if (!session) return { status: 'blocked', warning: unavailableWarning };
  if (session.blocked) return { status: 'blocked', warning: session.blocked };
  const storage = session.storage;
  if (!storage?.setItem) return { status: 'blocked', warning: unavailableWarning };
  try {
    const serialized = JSON.stringify(workspace);
    if (serialized === session.serialized) return { status: 'unchanged' };
    if (storage.getItem(STORAGE_KEY) !== session.expectedCurrent) {
      return { status: 'blocked', warning: 'The saved workspace changed in another session. Reload CHROMA before saving more changes.' };
    }
    // Canonical v2 edits do not need migration backups on every cold launch.
    for (const snapshot of state.status === 'ready' ? [] : state.preservation) {
      let backupKey = snapshot.backupKey;
      if (!backupKey) {
        const base = recoveryKey(snapshot);
        backupKey = base;
        let suffix = 0;
        let previous = storage.getItem(backupKey);
        while (previous !== null && previous !== snapshot.raw) {
          backupKey = `${base}-${++suffix}`;
          previous = storage.getItem(backupKey);
        }
        if (previous === null) storage.setItem(backupKey, snapshot.raw);
      }
      if (storage.getItem(backupKey) !== snapshot.raw) throw new Error('Recovery copy was not retained.');
      snapshot.backupKey = backupKey;
    }
    storage.setItem(STORAGE_KEY, serialized);
    if (storage.getItem(STORAGE_KEY) !== serialized) throw new Error('Workspace write was not retained.');
    session.expectedCurrent = serialized;
    session.serialized = serialized;
    return { status: 'saved' };
  } catch {
    return { status: 'blocked', warning: state.preservation.length
      ? 'The workspace could not be saved safely. The original is preserved. Export your library to keep your changes.'
      : unavailableWarning };
  }
}

export function loadWorkspace(storage: WorkspaceStorageSource): WorkspaceData {
  return loadWorkspaceState(storage).workspace;
}

export function parseLibraryImport(input: unknown): WorkspaceData {
  const data = object(input);
  if (Object.prototype.hasOwnProperty.call(data, 'folders') && (!Array.isArray(data.folders) || data.folders.some(value => {
    const folder = object(value);
    return !text(folder.name, '', 80);
  }))) throw new Error('Some folders in this backup are invalid. No changes were made.');
  if (Array.isArray(data.colours) && Array.isArray(data.library)) throw new Error('This backup contains two competing colour lists. Choose a standard CHROMA export.');
  if (!Array.isArray(data.colours) && !Array.isArray(data.library)) throw new Error('Choose a CHROMA library JSON backup containing a colours array.');
  const result = normaliseData(data);
  if (colourList(data).length !== result.library.length || list(data.comparisons).length !== result.comparisons.length) throw new Error('Some colours in this backup are invalid. No changes were made.');
  return result;
}
