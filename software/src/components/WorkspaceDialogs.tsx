import { useState, type FormEvent } from 'react';
import { Bookmark, GitCompareArrows, SlidersHorizontal, Target } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import { colorInfo, normalizeHex } from '../lib/color';
import { ColourMetrics, ColourSwatch, Modal, ProjectSelect } from './ui';

function ColourEditor({ hex, id, source, captureId }: { hex: string; id?: string; source?: string; captureId?: string }) {
  const { workspace, saveColour, closeDialog, toast } = useWorkspace();
  const existing = workspace.library.find(colour => colour.id === id);
  const [value, setValue] = useState(hex);
  const [name, setName] = useState(existing?.name || colorInfo(hex).name);
  const [tags, setTags] = useState(existing?.tags.join(', ') || '');
  const [project, setProject] = useState(existing?.projectId || '');
  const [error, setError] = useState('');
  function submit(event: FormEvent) { event.preventDefault(); try { if (!name.trim()) throw new Error('Give your colour a name.'); saveColour({ id, hex: normalizeHex(value), name, tags: tags.split(','), projectId: project || undefined, source, captureId }); closeDialog(); toast(existing ? 'Colour updated. Every project sees the change.' : 'Colour saved to your library.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Please check your colour.'); } }
  return <Modal title={existing ? 'Make it your own.' : 'A colour worth keeping.'} onClose={closeDialog}><form id="save-form" onSubmit={submit}><div className="editor-preview" style={{ background: /^#[a-f0-9]{6}$/i.test(value) ? value : hex }} /><label className="label" htmlFor="save-hex">HEX colour</label><input className="input" id="save-hex" value={value} onChange={event => setValue(event.target.value)} maxLength={7} required /><label className="label" htmlFor="save-name">Colour name</label><input className="input" id="save-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoFocus /><label className="label" htmlFor="save-tags">Tags <span className="font-normal text-stone-400">· optional</span></label><input className="input" id="save-tags" value={tags} onChange={event => setTags(event.target.value)} maxLength={450} placeholder="warm, packaging, print proof" /><p className="helper">Separate tags with commas.</p><ProjectSelect value={project} onChange={setProject} label="Save to project" /><p className="error-message" role="alert">{error}</p><button className="btn primary full-width" type="submit"><Bookmark size={16} />{existing ? 'Save changes' : 'Save Colour'}</button></form></Modal>;
}
export function WorkspaceDialogs() {
  const { dialog, closeDialog, workspace, openColourEditor, setCompare, navigate, useLibraryMatchTarget } = useWorkspace();
  if (!dialog) return null;
  if (dialog.type === 'copy') return <Modal title="Ready to copy." onClose={closeDialog}><p className="modal-copy">Select the value and copy it with your keyboard.</p><textarea className="input" value={dialog.value} readOnly autoFocus onFocus={event => event.target.select()} rows={4} aria-label="Value to copy" /></Modal>;
  if (dialog.type === 'edit') return <ColourEditor key={`${dialog.hex}-${dialog.id}-${dialog.source}`} hex={dialog.hex} id={dialog.id} source={dialog.source} captureId={dialog.captureId} />;
  const record = workspace.library.find(item => item.id === dialog.id);
  const name = record?.name || colorInfo(dialog.hex).name;
  return <Modal title={name} onClose={closeDialog}><ColourSwatch hex={dialog.hex} name={name} /><ColourMetrics hex={dialog.hex} />{record && <p className="helper">Saved {new Date(record.createdAt).toLocaleDateString()} {record.tags.length ? `· ${record.tags.join(', ')}` : ''}</p>}<div className="button-row mt-5">{record && <button className="btn secondary" onClick={() => useLibraryMatchTarget(record.id)}><Target size={16} />Use as Match Target</button>}<button className="btn primary" onClick={() => openColourEditor(dialog.hex, dialog.id)}><Bookmark size={16} />{record ? 'Rename / edit' : 'Save colour'}</button><button className="btn secondary" onClick={() => { setCompare(dialog.hex, workspace.latest.hex); navigate('compare'); }}><GitCompareArrows size={16} />Compare</button></div></Modal>;
}
