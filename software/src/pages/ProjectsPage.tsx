import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, CheckSquare, ChevronRight, Folder, FolderInput, FolderPlus, Heart, Layers, MoreHorizontal, Palette, Pencil, Plus, Share2, Trash2, X } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import { MatchResult, Modal, ThemedSelect } from '../components/ui';
import { PageHeaderSlots } from '../components/PageHeaderSlots';
import { colorInfo } from '../lib/color';
import { exportLibraryFile } from '../services/libraryExport';
import type { ColourRecord, Project, ProjectFolder } from '../types';
import { formatCreatedAt } from './LibraryPage';
import './collections.css';
import './collections-studio.css';
import './collections-wireframe.css';
import './project-folders.css';

type ProjectEditor = { id?: string; name: string; notes: string; folderId: string };

export default function ProjectsPage() {
  const { workspace, view, createProject, updateProject, deleteProject, createFolder, updateFolder, deleteFolder, moveProjectsToFolder, saveColour, setColourFavourite, updateComparison, openColourDetail, openColourEditor, setCompare, navigate, goBack, toast } = useWorkspace();
  const [editor, setEditor] = useState<ProjectEditor | null>(null);
  const [folderEditor, setFolderEditor] = useState<{ id?: string; name: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<ProjectFolder | null>(null);
  const [notes, setNotes] = useState('');
  const draft = useRef<{ id: string; notes: string; original: string } | null>(null);
  const [menuProject, setMenuProject] = useState<Project | null>(null);
  const [menuFolder, setMenuFolder] = useState<ProjectFolder | null>(null);
  const [showComparisons, setShowComparisons] = useState(false);
  const [colourActions, setColourActions] = useState<ColourRecord | null>(null);
  const [addKind, setAddKind] = useState<'colour' | 'comparison' | null>(null);
  const [addId, setAddId] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [moveFolder, setMoveFolder] = useState('');
  const [addingProjects, setAddingProjects] = useState(false);
  const [addProjectIds, setAddProjectIds] = useState<string[]>([]);
  const folders = workspace.folders || [];
  let routeId = '';
  try { routeId = decodeURIComponent(view.split('/').slice(1).join('/')); } catch { /* An invalid URL must not prevent loading the project list. */ }
  const selected = view.startsWith('detail/') ? workspace.projects.find(project => project.id === routeId) : undefined;
  const selectedFolder = view.startsWith('folder/') ? folders.find(folder => folder.id === routeId) : undefined;
  const colours = workspace.library.filter(colour => colour.projectId === selected?.id);
  const comparisons = workspace.comparisons.filter(comparison => comparison.projectId === selected?.id);
  const availableColours = workspace.library.filter(colour => colour.projectId !== selected?.id);
  const availableComparisons = workspace.comparisons.filter(comparison => comparison.projectId !== selected?.id);
  const projects = workspace.projects.filter(project => selectedFolder ? project.folderId === selectedFolder.id : !project.folderId || !folders.some(folder => folder.id === project.folderId));
  const availableProjects = workspace.projects.filter(project => project.folderId !== selectedFolder?.id);
  const isFavourite = (colour: ColourRecord) => (colour.tags || []).some(tag => /^(favourite|favorite)$/i.test(tag));
  const paletteFavourite = colours.length > 0 && colours.every(isFavourite);
  const notesDirty = !!selected && notes !== selected.notes;

  useEffect(() => {
    setNotes(selected?.notes || '');
    draft.current = selected ? { id: selected.id, notes: selected.notes, original: selected.notes } : null;
    return () => { if (draft.current && draft.current.notes !== draft.current.original) updateProject(draft.current.id, { notes: draft.current.notes }); };
  }, [selected?.id, updateProject]);
  useEffect(() => { setSelecting(false); setSelectedProjects([]); setMenuProject(null); setMenuFolder(null); }, [view]);

  function saveNotes() { if (selected && notesDirty) { updateProject(selected.id, { notes }); if (draft.current?.id === selected.id) draft.current.original = notes; } }
  function selectProject(id: string) { saveNotes(); setMenuProject(null); navigate('projects', `detail/${encodeURIComponent(id)}`); }
  function openFolder(id: string) { navigate('projects', `folder/${encodeURIComponent(id)}`); }
  function back() { saveNotes(); goBack('projects', selected?.folderId ? `folder/${encodeURIComponent(selected.folderId)}` : ''); }
  function openEditor(project?: Project) { setMenuProject(null); setEditor(project ? { ...project, notes: selected?.id === project.id ? notes : project.notes, folderId: project.folderId || '' } : { name: '', notes: '', folderId: selectedFolder?.id || '' }); }
  function toggleSelected(id: string) { setSelectedProjects(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); }
  function openMove(ids: string[]) {
    setMoveIds(ids); setMoveFolder(ids.length === 1 ? workspace.projects.find(project => project.id === ids[0])?.folderId || '' : ''); setMenuProject(null);
  }
  function openAdd(kind: 'colour' | 'comparison') { setMenuProject(null); setAddKind(kind); setAddId(''); }
  function attachItem() {
    if (!selected || !addId) return;
    if (addKind === 'colour') {
      const colour = workspace.library.find(item => item.id === addId);
      if (colour) saveColour({ ...colour, projectId: selected.id });
    } else updateComparison(addId, { projectId: selected.id });
    setAddKind(null); toast('Added to project.');
  }
  async function shareProject(project: Project) {
    saveNotes();
    const record = selected?.id === project.id ? { ...project, notes } : project;
    try {
      toast(await exportLibraryFile(JSON.stringify({ product: 'CHROMA', version: 2, exportedAt: new Date().toISOString(), colours: workspace.library.filter(colour => colour.projectId === project.id), comparisons: workspace.comparisons.filter(comparison => comparison.projectId === project.id), projects: [record], folders: folders.filter(folder => folder.id === project.folderId) }, null, 2)));
    } catch (error) { toast(error instanceof Error ? error.message : 'This project could not be shared.'); }
  }
  function commitEditor(event: FormEvent) {
    event.preventDefault(); if (!editor?.name.trim()) return;
    try {
      if (editor.id) { updateProject(editor.id, { name: editor.name.trim(), notes: editor.notes, folderId: editor.folderId || undefined }); if (selected?.id === editor.id) { setNotes(editor.notes); draft.current = { id: editor.id, notes: editor.notes, original: editor.notes }; } }
      else { const project = createProject(editor.name.trim(), editor.notes, editor.folderId || undefined); selectProject(project.id); }
      setEditor(null);
    } catch (error) { toast(error instanceof Error ? error.message : 'The project could not be saved.'); }
  }
  function commitFolder(event: FormEvent) {
    event.preventDefault(); if (!folderEditor?.name.trim()) return;
    try { if (folderEditor.id) updateFolder(folderEditor.id, folderEditor.name); else { const folder = createFolder(folderEditor.name); openFolder(folder.id); } setFolderEditor(null); }
    catch (error) { toast(error instanceof Error ? error.message : 'The folder could not be saved.'); }
  }
  function commitMove() {
    if (!moveIds?.length) return;
    try { moveProjectsToFolder(moveIds, moveFolder || undefined); toast(moveFolder ? 'Projects moved to folder.' : 'Projects moved out of folder.'); setMoveIds(null); setSelecting(false); setSelectedProjects([]); }
    catch (error) { toast(error instanceof Error ? error.message : 'These projects could not be moved.'); }
  }

  return <div className="wireframe-page wf-collections wf-projects">
    <PageHeaderSlots title={selected?.name || selectedFolder?.name || 'Projects'} onBack={selected || selectedFolder ? back : undefined} backLabel={selected?.folderId ? 'Back to folder' : 'Back to projects'} actions={selected ? <><button className="wf-icon-button" aria-label="Share project" onClick={() => void shareProject(selected)}><Share2 size={20} /></button><button className="wf-icon-button" aria-label="Project actions" aria-expanded={menuProject?.id === selected.id} onClick={() => setMenuProject(menuProject ? null : selected)}><MoreHorizontal size={22} /></button></> : <><button className="wf-icon-button" aria-label="New project" onClick={() => openEditor()}><Plus size={25} /></button>{selectedFolder && <button className="wf-icon-button" aria-label="Folder actions" onClick={() => setMenuFolder(selectedFolder)}><MoreHorizontal size={22} /></button>}</>} />
    <h1 className="sr-only" tabIndex={-1}>{selected?.name || selectedFolder?.name || 'Projects'}</h1>
    {!selected ? <>
      <div className="wf-folder-toolbar">
        {!selectedFolder ? <button className="btn secondary" onClick={() => setFolderEditor({ name: '' })}><FolderPlus size={17} />New folder</button> : <button className="btn secondary" onClick={() => { setAddProjectIds([]); setAddingProjects(true); }}><FolderInput size={17} />Add projects</button>}
        {projects.length > 0 && <button className="text-button" aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelectedProjects([]); }}><CheckSquare size={16} />{selecting ? 'Cancel selection' : 'Select projects'}</button>}
      </div>
      {!selectedFolder && folders.length > 0 && <section className="wf-folders" aria-label="Project folders">{folders.map(folder => <article className="wf-folder-row" key={folder.id}><button className="wf-folder-open" aria-label={`Open folder ${folder.name}`} onClick={() => openFolder(folder.id)}><span className="wf-folder-icon"><Folder size={27} fill="currentColor" /></span><span><strong>{folder.name}</strong><small>{workspace.projects.filter(project => project.folderId === folder.id).length} projects</small></span><ChevronRight size={18} /></button><button className="wf-icon-button" aria-label={`Actions for folder ${folder.name}`} onClick={() => setMenuFolder(folder)}><MoreHorizontal size={20} /></button></article>)}</section>}
      {!selectedFolder && folders.length > 0 && projects.length > 0 && <h2 className="wf-project-group-title">Projects outside folders</h2>}
      {selecting && <div className="wf-project-selection-bar" role="group" aria-label="Selected projects"><span>{selectedProjects.length} selected</span><button className="text-button" onClick={() => setSelectedProjects(projects.map(project => project.id))}>Select all</button><button className="btn primary" disabled={!selectedProjects.length} onClick={() => openMove(selectedProjects)}><FolderInput size={16} />Move</button></div>}
      <div className="wf-project-list project-grid">{projects.map(project => {
        const projectColours = workspace.library.filter(colour => colour.projectId === project.id);
        return <article className={`wf-project-row project-card ${selectedProjects.includes(project.id) ? 'is-selected' : ''}`} key={project.id}>{selecting && <input className="wf-project-checkbox" type="checkbox" aria-label={`Select ${project.name}`} checked={selectedProjects.includes(project.id)} onChange={() => toggleSelected(project.id)} />}<button className="wf-project-open project-card-open" onClick={() => selecting ? toggleSelected(project.id) : selectProject(project.id)} aria-label={`${selecting ? 'Select' : 'Open'} ${project.name}`}><span className="wf-project-thumbnail">{projectColours.length ? projectColours.slice(0, 4).map(colour => <i key={colour.id} style={{ background: colour.hex }} />) : <Palette size={25} />}</span><span className="wf-project-copy"><strong>{project.name}</strong><small>{projectColours.length} {projectColours.length === 1 ? 'colour' : 'colours'} &middot; {formatCreatedAt(project.createdAt)}</small></span></button>{!selecting && <button className="wf-icon-button" aria-label={`Actions for ${project.name}`} onClick={() => setMenuProject(project)}><MoreHorizontal size={20} /></button>}</article>;
      })}</div>
      {projects.length === 0 && <div className="wf-empty"><p>{selectedFolder ? 'This folder is ready for your projects.' : folders.length ? 'All your projects are organised in folders.' : 'Create your first colour project.'}</p><button className="btn primary" onClick={() => openEditor()}><Plus size={17} />New project</button></div>}
    </> : <>
      {selected.folderId && <p className="wf-project-folder-label"><Folder size={14} />{folders.find(folder => folder.id === selected.folderId)?.name || 'Project folder'}</p>}
      <div className="wf-project-banner" aria-label={`${selected.name} palette preview`}>{colours.length ? colours.slice(0, 6).map(colour => <span key={colour.id} style={{ background: colour.hex }} />) : <Palette size={46} strokeWidth={1.3} />}</div>
      <div className="wf-project-detail-heading"><div><h2>{selected.name}</h2><p>{colours.length} {colours.length === 1 ? 'colour' : 'colours'} &middot; {formatCreatedAt(selected.createdAt)}</p></div><button className="wf-icon-button" disabled={!colours.length} aria-label="Favourite palette colours" aria-pressed={paletteFavourite} onClick={() => colours.forEach(colour => setColourFavourite(colour.id, !paletteFavourite))}><Heart size={22} fill={paletteFavourite ? 'currentColor' : 'none'} /></button></div>
      <section className="wf-project-palette-section"><h3>Colour Palette</h3><div className="wf-project-palette">{colours.map(colour => <button key={colour.id} style={{ background: colour.hex }} aria-label={`View ${colour.name}`} title={`${colour.name} ${colour.hex}`} onClick={() => openColourDetail(colour.hex, colour.id)} />)}{!colours.length && <p className="helper">Add saved colours to build your palette.</p>}</div></section>
      <section className="wf-project-notes project-notes"><label htmlFor="project-notes">Notes</label><textarea id="project-notes" className="input" rows={4} maxLength={5000} placeholder="Add your project notes" value={notes} onChange={event => { setNotes(event.target.value); draft.current = { id: selected.id, notes: event.target.value, original: draft.current?.original ?? selected.notes }; }} onBlur={saveNotes} /></section>
      <div className="wf-project-colour-thumbnails">{colours.map(colour => <button key={colour.id} style={{ background: colour.hex }} aria-label={`Actions for ${colour.name}`} title={colour.name} onClick={() => setColourActions(colour)} />)}<button className="wf-project-add-colour" aria-label="Add colour to project" onClick={() => openAdd('colour')}><Plus size={23} /></button></div>
    </>}
    {menuProject && <Modal title={selected ? 'Project actions' : menuProject.name} onClose={() => setMenuProject(null)}><div className="wf-action-menu" role="group" aria-label="Project actions">{!selected && <button onClick={() => selectProject(menuProject.id)}>Open project<ArrowUpRight size={16} /></button>}<button onClick={() => openEditor(menuProject)}><Pencil size={16} />Edit project</button><button onClick={() => openMove([menuProject.id])}><FolderInput size={16} />Move to folder</button>{selected ? <><button onClick={() => { saveNotes(); setMenuProject(null); toast('Project notes saved.'); }}>Save notes</button><button onClick={() => openAdd('colour')}><Plus size={16} />Add colour</button><button onClick={() => openAdd('comparison')}><Plus size={16} />Add comparison</button><button onClick={() => { setShowComparisons(true); setMenuProject(null); }}><Layers size={16} />Comparisons <span>{comparisons.length}</span></button></> : <button onClick={() => { void shareProject(menuProject); setMenuProject(null); }}><Share2 size={16} />Share project</button>}<button onClick={() => { setPendingDelete(menuProject); setMenuProject(null); }}><Trash2 size={16} />Delete project</button></div></Modal>}
    {menuFolder && <Modal title={menuFolder.name} onClose={() => setMenuFolder(null)}><div className="wf-action-menu"><button onClick={() => { openFolder(menuFolder.id); setMenuFolder(null); }}><Folder size={17} />Open folder</button><button onClick={() => { setFolderEditor(menuFolder); setMenuFolder(null); }}><Pencil size={17} />Rename folder</button><button onClick={() => { setPendingFolderDelete(menuFolder); setMenuFolder(null); }}><Trash2 size={17} />Delete folder</button></div></Modal>}
    {editor && <Modal title={editor.id ? 'Edit project' : 'Create a project'} onClose={() => setEditor(null)}><form onSubmit={commitEditor}><label htmlFor="project-name" className="label">Project name</label><input id="project-name" className="input" autoFocus required maxLength={80} value={editor.name} placeholder="e.g. Summer Packaging" onChange={event => setEditor({ ...editor, name: event.target.value })} /><label htmlFor="project-folder" className="label">Folder</label><ThemedSelect id="project-folder" title="Project folder" value={editor.folderId} onChange={folderId => setEditor({ ...editor, folderId })} searchable options={[{ value: '', label: 'Outside folders' }, ...folders.map(folder => ({ value: folder.id, label: folder.name }))]} /><label htmlFor="new-project-notes" className="label">Notes</label><textarea id="new-project-notes" className="input" rows={4} maxLength={5000} value={editor.notes} onChange={event => setEditor({ ...editor, notes: event.target.value })} /><div className="button-row collection-modal-actions"><button className="btn secondary" type="button" onClick={() => setEditor(null)}>Cancel</button><button className="btn primary" type="submit">{editor.id ? 'Save changes' : 'Create project'}</button></div></form></Modal>}
    {folderEditor && <Modal title={folderEditor.id ? 'Rename folder' : 'Create a folder'} onClose={() => setFolderEditor(null)}><form onSubmit={commitFolder}><label htmlFor="folder-name" className="label">Folder name</label><input id="folder-name" className="input" autoFocus required maxLength={80} placeholder="e.g. Packaging" value={folderEditor.name} onChange={event => setFolderEditor({ ...folderEditor, name: event.target.value })} /><div className="button-row collection-modal-actions"><button className="btn secondary" type="button" onClick={() => setFolderEditor(null)}>Cancel</button><button className="btn primary" type="submit">{folderEditor.id ? 'Save name' : 'Create folder'}</button></div></form></Modal>}
    {moveIds && <Modal title={`Move ${moveIds.length === 1 ? 'project' : `${moveIds.length} projects`}`} onClose={() => setMoveIds(null)}><form onSubmit={event => { event.preventDefault(); commitMove(); }}><label htmlFor="move-project-folder" className="label">Destination</label><ThemedSelect id="move-project-folder" title="Move to folder" value={moveFolder} onChange={setMoveFolder} searchable options={[{ value: '', label: 'Outside folders' }, ...folders.map(folder => ({ value: folder.id, label: folder.name }))]} />{!folders.length && <p className="helper">Create a folder from the Projects list to group projects.</p>}<div className="button-row collection-modal-actions"><button className="btn secondary" type="button" onClick={() => setMoveIds(null)}>Cancel</button><button className="btn primary" type="submit">Move projects</button></div></form></Modal>}
    {addingProjects && selectedFolder && <Modal title={`Add projects to ${selectedFolder.name}`} onClose={() => setAddingProjects(false)}>{availableProjects.length ? <form onSubmit={event => { event.preventDefault(); try { moveProjectsToFolder(addProjectIds, selectedFolder.id); setAddingProjects(false); toast('Projects added to folder.'); } catch (error) { toast(error instanceof Error ? error.message : 'Projects could not be added.'); } }}><div className="wf-folder-project-choices">{availableProjects.map(project => <label key={project.id}><input type="checkbox" checked={addProjectIds.includes(project.id)} onChange={() => setAddProjectIds(previous => previous.includes(project.id) ? previous.filter(id => id !== project.id) : [...previous, project.id])} /><span><strong>{project.name}</strong><small>{folders.find(folder => folder.id === project.folderId)?.name || 'Outside folders'}</small></span></label>)}</div><p className="helper">Projects in another folder move here. Their colours and notes stay with them.</p><div className="button-row collection-modal-actions"><button className="btn secondary" type="button" onClick={() => setAddingProjects(false)}>Cancel</button><button className="btn primary" type="submit" disabled={!addProjectIds.length}>Add projects</button></div></form> : <><p>All existing projects are already in this folder.</p><button className="btn primary" onClick={() => { setAddingProjects(false); openEditor(); }}>New project<Plus size={17} /></button></>}</Modal>}
    {pendingFolderDelete && <Modal title="Delete folder?" onClose={() => setPendingFolderDelete(null)}><p>Remove &ldquo;{pendingFolderDelete.name}&rdquo;? Its projects will move outside folders. No projects, notes, colours or comparisons will be deleted.</p><div className="button-row collection-modal-actions"><button className="btn secondary" onClick={() => setPendingFolderDelete(null)}>Keep folder</button><button className="btn primary" onClick={() => { deleteFolder(pendingFolderDelete.id); const returnToParent = selectedFolder?.id === pendingFolderDelete.id; setPendingFolderDelete(null); if (returnToParent) requestAnimationFrame(() => goBack('projects')); toast('Folder removed. Its projects are preserved.'); }}>Delete folder</button></div></Modal>}
    {pendingDelete && <Modal title="Delete project?" onClose={() => setPendingDelete(null)}><p>&ldquo;{pendingDelete.name}&rdquo; and its notes will be deleted. Its colours and comparisons will remain in your library.</p><div className="button-row collection-modal-actions"><button className="btn secondary" onClick={() => setPendingDelete(null)}>Keep project</button><button className="btn primary" onClick={() => { draft.current = null; deleteProject(pendingDelete.id); const returnToParent = pendingDelete.id === selected?.id; const parentView = pendingDelete.folderId ? 'folder/' + encodeURIComponent(pendingDelete.folderId) : ''; setPendingDelete(null); if (returnToParent) requestAnimationFrame(() => goBack('projects', parentView)); }}>Delete project</button></div></Modal>}
    {colourActions && <Modal title={colourActions.name} onClose={() => setColourActions(null)}><div className="wf-detail-colour" style={{ background: colourActions.hex }} /><strong>{colourActions.hex}</strong><div className="wf-action-menu"><button onClick={() => { openColourDetail(colourActions.hex, colourActions.id); setColourActions(null); }}>Colour values<ArrowUpRight size={16} /></button><button onClick={() => { openColourEditor(colourActions.hex, colourActions.id); setColourActions(null); }}><Pencil size={16} />Edit colour</button><button onClick={() => { saveColour({ ...colourActions, projectId: undefined }); setColourActions(null); toast('Colour removed from project. It is still in your library.'); }}><X size={16} />Remove from project</button></div></Modal>}
    {showComparisons && <Modal title="Project comparisons" onClose={() => setShowComparisons(false)}><div className="collection-comparisons">{comparisons.map(comparison => <article className="panel collection-comparison" key={comparison.id}><div className="collection-comparison-heading"><h2>{comparison.name}</h2><button className="collection-icon" aria-label={`Remove ${comparison.name} from project`} onClick={() => { updateComparison(comparison.id, { projectId: undefined }); toast('Comparison removed from project. It is still in your library.'); }}><X size={16} /></button></div><div className="collection-pair"><button style={{ background: comparison.a, color: colorInfo(comparison.a).textColor }} onClick={() => { setShowComparisons(false); openColourDetail(comparison.a); }}>{comparison.a}</button><button style={{ background: comparison.b, color: colorInfo(comparison.b).textColor }} onClick={() => { setShowComparisons(false); openColourDetail(comparison.b); }}>{comparison.b}</button></div><MatchResult a={comparison.a} b={comparison.b} deviceDeltaE={comparison.deviceDeltaE} sampleSource={comparison.sampleSource} matchTarget={comparison.matchTarget} /><button className="text-button" onClick={() => { setCompare(comparison.a, comparison.b, comparison.deviceDeltaE, comparison.sampleSource, comparison.matchTarget, comparison.referenceSource); setShowComparisons(false); navigate('compare', 'result'); }}>Open comparison<ArrowUpRight size={14} /></button></article>)}</div>{comparisons.length === 0 && <><p>No comparisons attached.</p><button className="btn primary" onClick={() => { setShowComparisons(false); openAdd('comparison'); }}>Add comparison<Plus size={16} /></button></>}</Modal>}
    {addKind && selected && <Modal title={`Add ${addKind} to project`} onClose={() => setAddKind(null)}>{(addKind === 'colour' ? availableColours.length : availableComparisons.length) === 0 ? <><p>{addKind === 'colour' ? 'There are no other saved colours to add.' : 'There are no other saved comparisons to add.'}</p><button className="btn primary" onClick={() => { setAddKind(null); navigate(addKind === 'colour' ? 'scan' : 'compare'); }}>{addKind === 'colour' ? 'Scan a colour' : 'Compare colours'}<ArrowUpRight size={15} /></button></> : <form onSubmit={event => { event.preventDefault(); attachItem(); }}><label htmlFor="project-item" className="label">Saved {addKind}</label><ThemedSelect id="project-item" title={`Choose a saved ${addKind}`} value={addId} onChange={setAddId} searchable options={[{ value: '', label: `Choose a ${addKind}` }, ...(addKind === 'colour' ? availableColours : availableComparisons).map(item => ({ value: item.id, label: item.name, colours: 'hex' in item ? [item.hex] : [item.a, item.b], description: `${'hex' in item ? item.hex : `${item.a} / ${item.b}`} · ${item.projectId ? workspace.projects.find(project => project.id === item.projectId)?.name || 'Another project' : 'Library only'}` }))]} /><p className="helper">Items assigned to another project will move here.</p><div className="button-row collection-modal-actions"><button className="btn secondary" type="button" onClick={() => setAddKind(null)}>Cancel</button><button className="btn primary" type="submit" disabled={!addId}>Add to project</button></div></form>}</Modal>}
  </div>;
}
