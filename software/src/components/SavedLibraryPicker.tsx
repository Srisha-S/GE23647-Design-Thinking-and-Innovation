import { useEffect, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ColourRecord } from '../types';
import { Modal } from './ui';
import './saved-library-picker.css';

export function SavedLibraryPicker({ searchId, onChoose, onClose, onOpenLibrary, selectedId }: {
  searchId: string;
  onChoose: (colour: ColourRecord) => void;
  onClose: () => void;
  onOpenLibrary: () => void;
  selectedId?: string;
}) {
  const { workspace } = useWorkspace();
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const colours = workspace.library.filter(record =>
    [record.name, record.hex, ...(record.tags || [])].some(value => value.toLocaleLowerCase().includes(query))
  );

  return <Modal title="Choose from Saved Library" onClose={onClose}>
    <label className="label" htmlFor={searchId}>Search saved colours</label>
    <div className="saved-library-search">
      <Search size={17} aria-hidden="true" />
      <input id={searchId} className="input" type="search" autoFocus value={search}
        placeholder="Name, HEX or tag" onChange={event => setSearch(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    </div>
    <div className="saved-library-colours">
      {colours.map(record => <button key={record.id} type="button" data-library-colour={record.id}
        data-convert-colour={searchId === 'convert-library-search' ? record.id : undefined}
        aria-pressed={selectedId === record.id} onClick={() => onChoose(record)}>
        <i style={{ background: record.hex }} aria-hidden="true" />
        <span><strong>{record.name}</strong><small>{record.hex}</small></span>
        {selectedId === record.id && <Check className="themed-picker-check" size={20} aria-hidden="true" />}
      </button>)}
    </div>
    {!colours.length && <p className="helper" role="status">
      {workspace.library.length ? 'No saved colours match your search.' : 'Save a colour to your Library to choose it here.'}
    </p>}
    <button className="text-button saved-library-open" type="button" onClick={onOpenLibrary}>Open Library</button>
  </Modal>;
}

/** Every saved-colour field uses the same searchable, visual Library picker. */
export function SavedLibrarySelect({ id, value, onChoose, onOpenLibrary, disabled = false }: {
  id: string; value?: string; onChoose: (colour: ColourRecord) => void;
  onOpenLibrary: () => void; disabled?: boolean;
}) {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const selected = workspace.library.find(colour => colour.id === value);
  useEffect(() => { if (disabled || !workspace.library.length) setOpen(false); }, [disabled, workspace.library.length]);
  return <>
    <button id={id} type="button" className="input themed-picker-trigger" data-picker-trigger data-value={selected?.id || ''}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled || !workspace.library.length} onClick={() => setOpen(true)}>
      <span>{selected ? `${selected.name} · ${selected.hex}` : workspace.library.length ? 'Choose from Saved Library' : 'No saved colours yet'}</span>
      <ChevronDown size={18} aria-hidden="true" />
    </button>
    {open && !disabled && <SavedLibraryPicker searchId={`${id}-search`} selectedId={selected?.id}
      onClose={() => setOpen(false)} onChoose={colour => { setOpen(false); onChoose(colour); }}
      onOpenLibrary={() => { setOpen(false); onOpenLibrary(); }} />}
  </>;
}
