import type { Project, ProjectFolder, WorkspaceData } from '../types';

/** Folder changes never delete projects or the colours and comparisons linked to them. */
export function createProjectFolder(name: string, id: string, createdAt = new Date().toISOString()): ProjectFolder {
  const cleanName = name.trim().slice(0, 80);
  if (!cleanName) throw new Error('Give your folder a name.');
  return { id, name: cleanName, createdAt };
}

export function insertProjectFolder(workspace: WorkspaceData, folder: ProjectFolder): WorkspaceData {
  if (workspace.folders.some(item => item.id === folder.id)) return workspace;
  return { ...workspace, folders: [folder, ...workspace.folders] };
}

export function renameProjectFolder(workspace: WorkspaceData, id: string, name: string): WorkspaceData {
  const cleanName = name.trim().slice(0, 80);
  if (!cleanName) throw new Error('Give your folder a name.');
  return { ...workspace, folders: workspace.folders.map(folder => folder.id === id ? { ...folder, name: cleanName } : folder) };
}

export function moveProjectsToFolder(workspace: WorkspaceData, ids: readonly string[], folderId?: string): WorkspaceData {
  if (folderId && !workspace.folders.some(folder => folder.id === folderId)) throw new Error('This folder is no longer available. Choose another folder.');
  const selectedIds = new Set(ids);
  return { ...workspace, projects: workspace.projects.map(project => {
    if (!selectedIds.has(project.id) || project.folderId === folderId) return project;
    const { folderId: _previousFolder, ...unchanged } = project;
    return folderId ? { ...unchanged, folderId } : unchanged;
  }) };
}

export function removeProjectFolder(workspace: WorkspaceData, id: string): WorkspaceData {
  const ungrouped = moveProjectsToFolder(workspace, workspace.projects.filter(project => project.folderId === id).map(project => project.id));
  return { ...ungrouped, folders: workspace.folders.filter(folder => folder.id !== id) };
}

export function projectFolderId(workspace: WorkspaceData, folderId?: string): string | undefined {
  return folderId && workspace.folders.some(folder => folder.id === folderId) ? folderId : undefined;
}

/** Backup imports merge matching folder names and remap collisions without touching existing groups. */
export function mergeProjectFolders(current: readonly ProjectFolder[], imported: readonly ProjectFolder[], makeId: () => string): { folders: ProjectFolder[]; folderMap: Map<string, string> } {
  const folders = [...current];
  const folderMap = new Map<string, string>();
  for (const folder of imported) {
    const matching = folders.find(item => item.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase());
    if (matching) { folderMap.set(folder.id, matching.id); continue; }
    let id = folder.id;
    while (!id || folders.some(item => item.id === id)) id = makeId();
    folders.push({ ...folder, id });
    folderMap.set(folder.id, id);
  }
  return { folders, folderMap };
}

export function remapProjectFolder(project: Project, folderMap: ReadonlyMap<string, string>): Project {
  const { folderId, ...unchanged } = project;
  const mapped = folderId ? folderMap.get(folderId) : undefined;
  return mapped ? { ...unchanged, folderId: mapped } : unchanged;
}
