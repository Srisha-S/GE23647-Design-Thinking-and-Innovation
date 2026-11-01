import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { colorInfo, deltaE, normalizeHex } from '../lib/color';
import { emptyImageMatch, normaliseMatchTargetMetadata, reduceImageMatch, remapMatchTargetMetadata, type ImageMatchState } from '../lib/imageMatch';
import { loadWorkspaceState, parseLibraryImport, persistWorkspace, uid } from './storage';
import { useDevice } from './DeviceContext';
import { exportLibraryFile } from '../services/libraryExport';
import { readScanAlerts } from '../lib/uiPreferences';
import { useAppNavigation } from './useAppNavigation';
import { createProjectFolder, insertProjectFolder, renameProjectFolder, removeProjectFolder, moveProjectsToFolder as moveFolderProjects, projectFolderId, mergeProjectFolders, remapProjectFolder } from '../lib/projectFolders';
import type { ColourRecord, ComparisonRecord, DeviceReading, MatchTargetMetadata, Project, ProjectFolder, Route, SaveColourInput, WorkspaceData } from '../types';
export { routeFromHash } from './useAppNavigation';

interface ComparisonPair { a: string; b: string; deviceDeltaE?: number; waitingForSample?: boolean; sampleSource?: string; referenceSource?: string; matchTarget?: MatchTargetMetadata }

export type WorkspaceDialog = { type: 'edit' | 'detail'; hex: string; id?: string; source?: string; captureId?: string } | { type: 'copy'; value: string } | null;
interface WorkspaceContextValue {
  workspace: WorkspaceData;
  route: Route;
  view: string;
  navigate: (route: Route, view?: string, replace?: boolean) => void;
  goBack: (fallback?: Route, fallbackView?: string) => void;
  canGoBack: boolean;
  toast: (message: string) => void;
  toastMessage: string;
  copy: (value: string) => Promise<void>;
  dialog: WorkspaceDialog;
  closeDialog: () => void;
  openColourEditor: (hex: string, id?: string, source?: string, captureId?: string) => void;
  openColourDetail: (hex: string, id?: string) => void;
  saveColour: (input: SaveColourInput) => ColourRecord;
  setColourFavourite: (id: string, favourite: boolean) => void;
  deleteColour: (id: string) => void;
  saveComparison: (a: string, b: string, projectId?: string, name?: string, deviceDeltaE?: number, sampleSource?: string, matchTarget?: MatchTargetMetadata, referenceSource?: string) => ComparisonRecord;
  updateComparison: (id: string, input: { projectId?: string; name?: string }) => void;
  deleteComparison: (id: string) => void;
  createProject: (name: string, notes?: string, folderId?: string) => Project;
  updateProject: (id: string, input: { name?: string; notes?: string; folderId?: string }) => void;
  createFolder: (name: string) => ProjectFolder;
  updateFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
  moveProjectsToFolder: (ids: string[], folderId?: string) => void;
  deleteProject: (id: string) => void;
  compare: ComparisonPair;
  setCompare: (a: string, b: string, deviceDeltaE?: number, sampleSource?: string, matchTarget?: MatchTargetMetadata, referenceSource?: string) => void;
  exportLibrary: () => void;
  importLibrary: (file: File) => Promise<void>;
  imageMatch: ImageMatchState;
  setImageMatchTarget: (hex: string | null, imageName?: string) => void;
  useLibraryMatchTarget: (id: string) => void;
  setImageMatchSample: (sample: DeviceReading | null) => void;
  exportColour: (hex: string) => Promise<void>;
  exportComparison: (a: string, b: string, name?: string, sampleSource?: string, matchTarget?: MatchTargetMetadata) => Promise<void>;
}
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [hydration] = useState(() => loadWorkspaceState(() => window.localStorage));
  const [workspace, setWorkspace] = useState(() => hydration.workspace);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [toastMessage, setToastMessage] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const [compare, setPair] = useState<ComparisonPair>({ a: '#C76B4A', b: '#C86A4B' });
  const { reading, bleReference, bleComparison } = useDevice();
  const [imageMatch, dispatchImageMatch] = useReducer(reduceImageMatch, emptyImageMatch);
  const { route, view, navigate, goBack, canGoBack } = useAppNavigation((from, to) => {
    setDialog(null);
    if (from === 'image' && to !== 'image' && imageMatch.target?.source === 'image') dispatchImageMatch({ type: 'target', hex: null });
  });
  const setImageMatchTarget = useCallback((hex: string | null, imageName?: string) => dispatchImageMatch({ type: 'target', hex, metadata: { source: 'image', imageName } }), []);
  const setImageMatchSample = useCallback((sample: DeviceReading | null) => dispatchImageMatch({ type: 'sample', reading: sample }), []);
  useEffect(() => { dispatchImageMatch({ type: 'reading', reading }); }, [reading]);
  const lastReading = useRef<DeviceReading | null>(null);
  const nextPhysicalReference = useRef(true);
  const toast = useCallback((message: string) => { clearTimeout(toastTimer.current); setToastMessage(message); toastTimer.current = setTimeout(() => setToastMessage(''), 4200); }, []);
  const updateWorkspace = useCallback((change: (previous: WorkspaceData) => WorkspaceData) => {
    const next = change(workspaceRef.current);
    workspaceRef.current = next;
    setWorkspace(next);
  }, []);
  // Routine legacy normalization is handled quietly; blocked reads/saves still notify the user.
  useEffect(() => { if (hydration.status !== 'recovered' && hydration.warning) toast(hydration.warning); }, [hydration, toast]);
  useEffect(() => {
    const result = persistWorkspace(hydration, workspace);
    if (result.warning) toast(result.warning);
  }, [hydration, workspace, toast]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const useLibraryMatchTarget = useCallback((id: string) => {
    const colour = workspaceRef.current.library.find(item => item.id === id);
    if (!colour) { toast('This saved colour is no longer in your Library. Choose another colour.'); return; }
    dispatchImageMatch({ type: 'target', hex: colour.hex, metadata: { source: 'library', name: colour.name, libraryItemId: colour.id, libraryProjectId: colour.projectId } });
    navigate('image');
  }, [navigate, toast]);
  useEffect(() => {
    if (!reading || lastReading.current === reading) return;
    lastReading.current = reading;
    const info = colorInfo(reading.hex);
    const record: ColourRecord = { id: uid(), hex: info.hex, name: reading.name || info.name, rgb: info.rgb, tags: [], createdAt: reading.timestamp, source: reading.source, clear: reading.clear };
    updateWorkspace(previous => ({ ...previous, latest: record, history: [record, ...previous.history].slice(0, 50) }));
    if (readScanAlerts()) toast(`${reading.source === 'demo' ? 'Demo colour' : 'Colour'} captured: ${record.hex}`);
    if (reading.deviceMode === 'compare') {
      const isReference = nextPhysicalReference.current;
      setPair(pair => isReference ? { a: record.hex, b: pair.b, referenceSource: record.source } : { a: pair.a, b: record.hex, referenceSource: pair.referenceSource, sampleSource: record.source });
      nextPhysicalReference.current = !nextPhysicalReference.current;
      navigate('compare');
    } else if (reading.deviceMode === 'image-match') navigate('image');
  }, [reading, navigate, toast, updateWorkspace]);
  useEffect(() => {
    setPair(pair => bleReference ? { a: bleReference.hex, b: pair.b, referenceSource: 'bluetooth', waitingForSample: true } : { a: pair.a, b: pair.b });
  }, [bleReference]);
  useEffect(() => {
    if (bleComparison) setPair({ a: bleComparison.reference.hex, b: bleComparison.sample.hex, deviceDeltaE: bleComparison.deltaE, sampleSource: 'bluetooth', referenceSource: 'bluetooth' });
  }, [bleComparison]);
  const saveColour = useCallback((input: SaveColourInput) => {
    const info = colorInfo(input.hex);
    const existing = input.id ? workspaceRef.current.library.find(colour => colour.id === input.id) : undefined;
    const latest = workspaceRef.current.latest;
    const historical = input.captureId ? workspaceRef.current.history.find(item => item.id === input.captureId) : undefined;
    const source = input.source ?? existing?.source ?? historical?.source ?? (latest.hex === info.hex ? latest.source : 'manual');
    // A digital colour can equal a sensor reading without being that capture.
    // Keep sensor metadata only for the same physical source and unchanged HEX.
    const capture = existing ?? historical ?? latest;
    const clear = ['bluetooth', 'usb', 'wifi'].includes(source) && capture.source === source && capture.hex === info.hex ? capture.clear : undefined;
    const record: ColourRecord = {
      ...existing,
      id: existing?.id || uid(), hex: info.hex, rgb: info.rgb,
      name: (input.name ?? existing?.name ?? info.name).trim().slice(0, 80) || info.name,
      tags: [...new Set((input.tags ?? existing?.tags ?? []).map(tag => tag.trim().slice(0, 30)).filter(Boolean))].slice(0, 15),
      source,
      createdAt: existing?.createdAt ?? new Date().toISOString(), projectId: input.projectId || undefined,
      clear,
    };
    updateWorkspace(data => ({ ...data, library: existing ? data.library.map(item => item.id === existing.id ? record : item) : [record, ...data.library] }));
    return record;
  }, [updateWorkspace]);
  const setColourFavourite = useCallback((id: string, favourite: boolean) => {
    const colour = workspaceRef.current.library.find(item => item.id === id);
    if (!colour) { toast('This colour is no longer in your library.'); return; }
    const isFavouriteTag = (tag: string) => ['favourite', 'favorite'].includes(tag.toLocaleLowerCase());
    const wasFavourite = colour.tags.some(isFavouriteTag);
    if (favourite === wasFavourite) return;
    if (favourite && colour.tags.length >= 15) { toast('This colour has 15 tags. Edit a tag to make room for favourite.'); return; }
    // A presentation-only tag change must preserve every field on imported and captured records.
    updateWorkspace(data => ({ ...data, library: data.library.map(item => item.id === id ? { ...item, tags: favourite ? [...item.tags, 'favourite'] : item.tags.filter(tag => !isFavouriteTag(tag)) } : item) }));
    toast(favourite ? 'Added to favourites.' : 'Removed from favourites.');
  }, [toast, updateWorkspace]);
  const deleteColour = useCallback((id: string) => updateWorkspace(data => ({ ...data, library: data.library.filter(item => item.id !== id) })), [updateWorkspace]);
  const saveComparison = useCallback((a: string, b: string, projectId?: string, name?: string, deviceDeltaE?: number, sampleSource?: string, matchTarget?: MatchTargetMetadata, referenceSource?: string) => {
    const metadata = normaliseMatchTargetMetadata(matchTarget);
    const record: ComparisonRecord = { id: uid(), a: normalizeHex(a), b: normalizeHex(b), name: name?.trim().slice(0, 100) || `${colorInfo(a).name} & ${colorInfo(b).name}`, projectId, createdAt: new Date().toISOString(), ...(deviceDeltaE !== undefined && Number.isFinite(deviceDeltaE) && deviceDeltaE >= 0 ? { deviceDeltaE } : {}), ...(sampleSource ? { sampleSource: sampleSource.slice(0, 30) } : {}), ...(referenceSource ? { referenceSource: referenceSource.slice(0, 30) } : {}), ...(metadata ? { matchTarget: metadata } : {}) };
    updateWorkspace(data => ({ ...data, comparisons: [record, ...data.comparisons] }));
    return record;
  }, [updateWorkspace]);
  const updateComparison = useCallback((id: string, input: { projectId?: string; name?: string }) => updateWorkspace(data => ({ ...data, comparisons: data.comparisons.map(item => item.id === id ? { ...item, ...input, name: input.name?.trim().slice(0, 100) || item.name } : item) })), [updateWorkspace]);
  const deleteComparison = useCallback((id: string) => updateWorkspace(data => ({ ...data, comparisons: data.comparisons.filter(item => item.id !== id) })), [updateWorkspace]);
  const createProject = useCallback((name: string, notes = '', folderId?: string) => {
    if (!name.trim()) throw new Error('Give your project a name.');
    const project: Project = { id: uid(), name: name.trim().slice(0, 80), notes: notes.slice(0, 5000), createdAt: new Date().toISOString(), ...(projectFolderId(workspaceRef.current, folderId) ? { folderId } : {}) };
    updateWorkspace(data => ({ ...data, projects: [project, ...data.projects] }));
    return project;
  }, [updateWorkspace]);
  const updateProject = useCallback((id: string, input: { name?: string; notes?: string; folderId?: string }) => updateWorkspace(data => {
    const next = { ...data, projects: data.projects.map(item => item.id === id ? { ...item, name: input.name?.trim().slice(0, 80) || item.name, notes: input.notes === undefined ? item.notes : input.notes.slice(0, 5000) } : item) };
    return 'folderId' in input ? moveFolderProjects(next, [id], input.folderId) : next;
  }), [updateWorkspace]);
  const createFolder = useCallback((name: string) => { const folder = createProjectFolder(name, uid()); updateWorkspace(data => insertProjectFolder(data, folder)); return folder; }, [updateWorkspace]);
  const updateFolder = useCallback((id: string, name: string) => updateWorkspace(data => renameProjectFolder(data, id, name)), [updateWorkspace]);
  const deleteFolder = useCallback((id: string) => updateWorkspace(data => removeProjectFolder(data, id)), [updateWorkspace]);
  const moveProjectsToFolder = useCallback((ids: string[], folderId?: string) => updateWorkspace(data => moveFolderProjects(data, ids, folderId)), [updateWorkspace]);
  const deleteProject = useCallback((id: string) => updateWorkspace(data => ({ ...data, projects: data.projects.filter(item => item.id !== id), library: data.library.map(item => item.projectId === id ? { ...item, projectId: undefined } : item), comparisons: data.comparisons.map(item => item.projectId === id ? { ...item, projectId: undefined } : item) })), [updateWorkspace]);
  const copy = useCallback(async (value: string) => { try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.'); } catch { setDialog({ type: 'copy', value }); } }, [toast]);
  const exportLibrary = useCallback(async () => {
    const data = workspaceRef.current;
    const contents = JSON.stringify({ product: 'CHROMA', version: 2, exportedAt: new Date().toISOString(), colours: data.library, comparisons: data.comparisons, projects: data.projects, folders: data.folders }, null, 2);
    try { toast(await exportLibraryFile(contents)); }
    catch (error) { toast(error instanceof Error ? error.message : 'The backup could not be shared. Please try again.'); }
  }, [toast]);
  const exportColour = useCallback(async (hex: string) => {
    try {
      const info = colorInfo(hex);
      const colour: ColourRecord = { id: uid(), hex: info.hex, rgb: info.rgb, name: info.name, tags: [], source: 'convert', createdAt: new Date().toISOString() };
      const contents = JSON.stringify({ product: 'CHROMA', version: 2, exportedAt: new Date().toISOString(), colours: [{ ...colour, formats: info }], comparisons: [], projects: [] }, null, 2);
      toast(await exportLibraryFile(contents, 'colour'));
    } catch (error) { toast(error instanceof Error ? error.message : 'The colour could not be shared. Please try again.'); }
  }, [toast]);
  const exportComparison = useCallback(async (a: string, b: string, name?: string, sampleSource?: string, matchTarget?: MatchTargetMetadata) => {
    try {
      const reference = colorInfo(a), sample = colorInfo(b);
      const comparison: ComparisonRecord = { id: uid(), a: reference.hex, b: sample.hex, name: name || 'Image match', createdAt: new Date().toISOString(), sampleSource, matchTarget: normaliseMatchTargetMetadata(matchTarget) };
      const contents = JSON.stringify({ product: 'CHROMA', version: 2, exportedAt: new Date().toISOString(), colours: [], comparisons: [{ ...comparison, deltaE: deltaE(a, b), method: 'CIEDE2000', reference, sample }], projects: [] }, null, 2);
      toast(await exportLibraryFile(contents, 'image-match'));
    } catch (error) { toast(error instanceof Error ? error.message : 'The comparison could not be shared. Please try again.'); }
  }, [toast]);
  const importLibrary = useCallback(async (file: File) => {
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a JSON backup smaller than 5 MB.');
    let parsed: unknown; try { parsed = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON.'); }
    const imported = parseLibraryImport(parsed);
    const current = workspaceRef.current;
    const { folders, folderMap } = mergeProjectFolders(current.folders, imported.folders, uid);
    const projectMap = new Map<string, string>();
    const projects = [...current.projects];
    imported.projects.map(project => remapProjectFolder(project, folderMap)).forEach(project => { const same = projects.find(item => item.id === project.id && item.name === project.name && item.folderId === project.folderId) || projects.find(item => item.name === project.name && item.folderId === project.folderId); if (same) projectMap.set(project.id, same.id); else { const added = { ...project, id: projects.some(item => item.id === project.id) ? uid() : project.id }; projects.push(added); projectMap.set(project.id, added.id); } });
    const library = [...current.library];
    const libraryMap = new Map<string, string>();
    imported.library.forEach(colour => {
      const projectId = colour.projectId ? projectMap.get(colour.projectId) : undefined;
      const duplicate = library.find(item => item.hex === colour.hex && item.name === colour.name && item.projectId === projectId);
      if (duplicate) libraryMap.set(colour.id, duplicate.id);
      else {
        const added = { ...colour, id: library.some(item => item.id === colour.id) ? uid() : colour.id, projectId };
        library.push(added); libraryMap.set(colour.id, added.id);
      }
    });
    const comparisons = [...current.comparisons];
    imported.comparisons.forEach(comparison => {
      const projectId = comparison.projectId ? projectMap.get(comparison.projectId) : undefined;
      const matchTarget = remapMatchTargetMetadata(comparison.matchTarget, libraryMap, projectMap);
      if (!comparisons.some(item => item.a === comparison.a && item.b === comparison.b && item.name === comparison.name && item.projectId === projectId && item.deviceDeltaE === comparison.deviceDeltaE && item.sampleSource === comparison.sampleSource && item.referenceSource === comparison.referenceSource && JSON.stringify(normaliseMatchTargetMetadata(item.matchTarget)) === JSON.stringify(matchTarget))) comparisons.push({ ...comparison, id: comparisons.some(item => item.id === comparison.id) ? uid() : comparison.id, projectId, matchTarget });
    });
    updateWorkspace(data => ({ ...data, projects, folders, library, comparisons }));
    toast(`Imported ${library.length - current.library.length} colours and ${projects.length - current.projects.length} projects. Existing work is preserved.`);
  }, [toast, updateWorkspace]);
  return <WorkspaceContext.Provider value={{ workspace, route, view, navigate, goBack, canGoBack, toast, toastMessage, copy, dialog, closeDialog: () => setDialog(null), openColourEditor: (hex, id, source, captureId) => setDialog({ type: 'edit', hex, id, source, captureId }), openColourDetail: (hex, id) => setDialog({ type: 'detail', hex, id }), saveColour, setColourFavourite, deleteColour, saveComparison, updateComparison, deleteComparison, createProject, updateProject, deleteProject, createFolder, updateFolder, deleteFolder, moveProjectsToFolder, compare, setCompare: (a, b, deviceDeltaE, sampleSource, matchTarget, referenceSource) => setPair({ a, b, sampleSource, referenceSource, matchTarget: normaliseMatchTargetMetadata(matchTarget), ...(deviceDeltaE !== undefined && Number.isFinite(deviceDeltaE) && deviceDeltaE >= 0 ? { deviceDeltaE } : {}) }), exportLibrary, importLibrary, imageMatch, setImageMatchTarget, useLibraryMatchTarget, setImageMatchSample, exportColour, exportComparison }}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace() { const context = useContext(WorkspaceContext); if (!context) throw new Error('useWorkspace requires WorkspaceProvider.'); return context; }
