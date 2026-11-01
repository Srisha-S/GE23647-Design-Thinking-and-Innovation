import { useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Copy, Download, Heart, MoreHorizontal, Paintbrush, Pencil, Plus, Search, SlidersHorizontal, Target, Trash2, Upload } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import { MatchResult, Modal, ProjectSelect, ThemedSelect } from '../components/ui';
import { PageHeaderSlots } from '../components/PageHeaderSlots';
import { colorInfo } from '../lib/color';
import type { ColourRecord, ComparisonRecord } from '../types';
import './collections.css';
import './collections-studio.css';
import './collections-wireframe.css';

export function formatCreatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function LibraryPage() {
  const { workspace, openColourEditor, openColourDetail, copy, setColourFavourite, deleteColour, deleteComparison, updateComparison, setCompare, navigate, exportLibrary, importLibrary, toast, useLibraryMatchTarget } = useWorkspace();
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [collection, setCollection] = useState<'all' | 'favourites' | 'recent'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showComparisons, setShowComparisons] = useState(false);
  const [detail, setDetail] = useState<ColourRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'colour' | 'comparison'; id: string; name: string } | null>(null);
  const [editing, setEditing] = useState<ComparisonRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const search = query.toLocaleLowerCase().trim();
  const isFavourite = (colour: ColourRecord) => (colour.tags || []).some(tag => ['favourite', 'favorite'].includes(tag.toLocaleLowerCase()));
  const colours = useMemo(() => (collection === 'recent' ? workspace.history : workspace.library).filter(colour => (projectFilter === 'all' || (projectFilter === 'unassigned' ? !colour.projectId : colour.projectId === projectFilter)) && (collection !== 'favourites' || isFavourite(colour)) && [colour.name, colour.hex, `${colour.rgb.r} ${colour.rgb.g} ${colour.rgb.b}`, ...(colour.tags || [])].some(value => value.toLocaleLowerCase().includes(search))).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)), [workspace.library, workspace.history, collection, projectFilter, search, sort]);

  async function handleImport(file?: File) {
    if (!file) return;
    setImporting(true);
    try { await importLibrary(file); } catch (error) { toast(error instanceof Error ? error.message : 'This library could not be imported.'); }
    finally { setImporting(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  return <div className="wireframe-page wf-collections wf-library">
    <PageHeaderSlots title="Library" actions={<button className="wf-icon-button" aria-label="Library actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={22} /></button>} />
    <h1 className="sr-only" tabIndex={-1}>Library</h1>
    {menuOpen && <div className="wf-action-menu" role="group" aria-label="Library actions">
      <button onClick={() => { setMenuOpen(false); openColourEditor(workspace.latest.hex); }}><Plus size={16} />Add colour</button>
      <button onClick={() => { setMenuOpen(false); setShowComparisons(true); }}>Comparisons <span>{workspace.comparisons.length}</span></button>
      <button onClick={() => { setMenuOpen(false); exportLibrary(); }}><Download size={16} />Export library</button>
      <button disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={16} />{importing ? 'Importing…' : 'Import library'}</button>
    </div>}
    <input hidden ref={fileInput} type="file" accept="application/json,.json" aria-label="Import library JSON file" onChange={event => void handleImport(event.target.files?.[0])} />
    <div className="wf-library-search"><label><Search size={18} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search colours, tags…" aria-label="Search library" /></label><button className="wf-icon-button" aria-label="Filter library" aria-expanded={showFilters} aria-controls="library-filters" onClick={() => setShowFilters(value => !value)}><SlidersHorizontal size={18} /></button></div>
    <div className="wf-collection-chips" role="group" aria-label="Colour collections">{(['all', 'favourites', 'recent'] as const).map(value => <button key={value} className={collection === value ? 'active' : ''} aria-pressed={collection === value} onClick={() => setCollection(value)}>{value === 'all' ? 'All' : value === 'favourites' ? 'Favourites' : 'Recent'}</button>)}</div>
    {showFilters && <div className="wf-filter-panel" id="library-filters"><div className="wf-picker-filter"><label htmlFor="library-project-filter">Project</label><ThemedSelect id="library-project-filter" ariaLabel="Filter by project" title="Filter by project" value={projectFilter} onChange={setProjectFilter} searchable options={[{ value: 'all', label: 'All projects' }, { value: 'unassigned', label: 'Unassigned' }, ...workspace.projects.map(project => ({ value: project.id, label: project.name }))]} /></div><div className="wf-picker-filter"><label htmlFor="library-sort">Sort</label><ThemedSelect id="library-sort" ariaLabel="Sort library" title="Sort library" value={sort} onChange={setSort} options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'name', label: 'Name A–Z' }]} /></div></div>}
    <div className="wf-library-grid library-grid">{colours.map(colour => <article className="wf-library-card library-card" key={colour.id}>
      <div className="wf-library-card-swatch"><button className="wf-library-swatch library-swatch" style={{ background: colour.hex }} onClick={() => setDetail(colour)} aria-label={`View ${colour.name}`} />{collection !== 'recent' && <button className="wf-favourite" style={{ color: colorInfo(colour.hex).textColor }} aria-label={`${isFavourite(colour) ? 'Remove' : 'Add'} ${colour.name} ${isFavourite(colour) ? 'from' : 'to'} favourites`} aria-pressed={isFavourite(colour)} onClick={() => setColourFavourite(colour.id, !isFavourite(colour))}><Heart size={18} fill={isFavourite(colour) ? 'currentColor' : 'none'} /></button>}</div>
      <button className="wf-library-card-hex" onClick={() => setDetail(colour)} aria-label={`Details for ${colour.name}`}>{colour.hex}</button>
    </article>)}</div>
    {colours.length === 0 && <div className="wf-empty"><p>{query || collection !== 'all' || projectFilter !== 'all' ? 'No matching colours.' : 'No saved colours yet.'}</p><button className="btn primary" onClick={() => { if (query || collection !== 'all' || projectFilter !== 'all') { setQuery(''); setCollection('all'); setProjectFilter('all'); } else openColourEditor(workspace.latest.hex); }}>{query || collection !== 'all' || projectFilter !== 'all' ? 'Reset filters' : 'Add colour'}</button></div>}
    {detail && <Modal title={detail.name} onClose={() => setDetail(null)}><div className="wf-detail-colour" style={{ background: detail.hex }} /><strong>{detail.hex}</strong><p className="helper">RGB {detail.rgb.r}, {detail.rgb.g}, {detail.rgb.b} · {formatCreatedAt(detail.createdAt)}</p><p className="helper">{detail.source}{detail.projectId ? ` · ${workspace.projects.find(project => project.id === detail.projectId)?.name || 'Project'}` : ''}</p>{(detail.tags || []).length > 0 && <div className="collection-tags">{detail.tags.map(tag => <button key={tag} onClick={() => { setQuery(tag); setDetail(null); }}>{tag}</button>)}</div>}<div className="wf-action-menu">
      <button onClick={() => { const colour = detail; setDetail(null); openColourDetail(colour.hex, collection === 'recent' ? undefined : colour.id); }}><ArrowUpRight size={16} />Colour values</button>
      <button onClick={() => { const colour = detail; setDetail(null); openColourEditor(colour.hex, collection === 'recent' ? undefined : colour.id, colour.source); }}><Pencil size={16} />{collection === 'recent' ? 'Save colour' : 'Rename / edit'}</button>
      <button onClick={() => void copy(detail.hex)}><Copy size={16} />Copy HEX</button>
      {collection !== 'recent' && <><button onClick={() => { useLibraryMatchTarget(detail.id); setDetail(null); }}><Target size={16} />Use as Match Target</button><button onClick={() => { location.hash = `visualize/library/${encodeURIComponent(detail.id)}`; setDetail(null); }}><Paintbrush size={16} />Visualize this colour</button><button onClick={() => { setPendingDelete({ kind: 'colour', id: detail.id, name: detail.name }); setDetail(null); }}><Trash2 size={16} />Delete colour</button></>}
    </div></Modal>}
    {showComparisons && <Modal title="Saved comparisons" onClose={() => setShowComparisons(false)}><div className="collection-comparisons">{workspace.comparisons.map(comparison => <article className="panel collection-comparison" key={comparison.id}><div className="collection-comparison-heading"><h2>{comparison.name}</h2><button className="collection-icon" aria-label={`Delete ${comparison.name}`} onClick={() => { setShowComparisons(false); setPendingDelete({ kind: 'comparison', id: comparison.id, name: comparison.name }); }}><Trash2 size={16} /></button></div><div className="collection-pair"><button style={{ background: comparison.a, color: colorInfo(comparison.a).textColor }} onClick={() => { setShowComparisons(false); openColourDetail(comparison.a); }}>{comparison.a}</button><button style={{ background: comparison.b, color: colorInfo(comparison.b).textColor }} onClick={() => { setShowComparisons(false); openColourDetail(comparison.b); }}>{comparison.b}</button></div><MatchResult a={comparison.a} b={comparison.b} deviceDeltaE={comparison.deviceDeltaE} sampleSource={comparison.sampleSource} matchTarget={comparison.matchTarget} /><div className="wf-action-menu"><button onClick={() => { setShowComparisons(false); setEditing({ ...comparison }); }}><Pencil size={16} />Edit details</button><button onClick={() => { setCompare(comparison.a, comparison.b, comparison.deviceDeltaE, comparison.sampleSource, comparison.matchTarget, comparison.referenceSource); setShowComparisons(false); navigate('compare'); }}>Open comparison <ArrowUpRight size={16} /></button></div></article>)}</div>{workspace.comparisons.length === 0 && <p>No saved comparisons yet.</p>}</Modal>}
    {pendingDelete && <Modal title={`Delete ${pendingDelete.kind}?`} onClose={() => setPendingDelete(null)}><p>“{pendingDelete.name}” will be removed from your library and its project.</p><div className="button-row collection-modal-actions"><button className="btn secondary" onClick={() => setPendingDelete(null)}>Keep it</button><button className="btn primary" onClick={() => { pendingDelete.kind === 'colour' ? deleteColour(pendingDelete.id) : deleteComparison(pendingDelete.id); setPendingDelete(null); }}>Delete {pendingDelete.kind}</button></div></Modal>}
    {editing && <Modal title="Edit comparison" onClose={() => setEditing(null)}><form onSubmit={event => { event.preventDefault(); if (!editing.name.trim()) return; updateComparison(editing.id, { name: editing.name.trim(), projectId: editing.projectId }); setEditing(null); }}><label className="label" htmlFor="comparison-name">Name</label><input id="comparison-name" className="input" autoFocus required maxLength={100} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /><ProjectSelect value={editing.projectId || ''} onChange={(projectId: string) => setEditing({ ...editing, projectId: projectId || undefined })} /><div className="button-row collection-modal-actions"><button className="btn secondary" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" type="submit">Save changes</button></div></form></Modal>}
  </div>;
}
