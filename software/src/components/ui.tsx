import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, FolderOpen, Search, X } from 'lucide-react';
import { openModal } from '../lib/dialogs';
import { colorInfo, deltaE } from '../lib/color';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ColourFormat, MatchTargetMetadata } from '../types';
import './themed-picker.css';

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1 tabIndex={-1}>{title}</h1>{description && <p>{description}</p>}</div>{actions}</div>;
}
export function ColourSwatch({ hex, label = 'YOUR COLOUR', name, large = true }: { hex: string; label?: string; name?: string; large?: boolean }) {
  const colour = colorInfo(hex);
  return <div className={large ? 'large-swatch' : 'compare-swatch'} style={{ backgroundColor: colour.hex, color: colour.textColor }}><span className="swatch-tag">{label}</span><div><div className="colour-name">{name || colour.name}</div><div className="colour-hex">{colour.hex}</div></div></div>;
}
export function colourValues(hex: string): Record<ColourFormat, string> {
  const info = colorInfo(hex);
  const values = (object: object, precision = 0) => Object.values(object).map((value: number) => Number(value.toFixed(precision))).join(', ');
  return { HEX: info.hex, RGB: values(info.rgb), LAB: values(info.lab, 2), CMYK: Object.values(info.cmyk).map(value => `${Number(value.toFixed(2))}%`).join(', '), HSL: `${Number(info.hsl.h.toFixed(2))}°, ${Number(info.hsl.s.toFixed(2))}%, ${Number(info.hsl.l.toFixed(2))}%` };
}
export function ColourMetrics({ hex, formats = ['HEX', 'RGB', 'LAB', 'CMYK', 'HSL'] }: { hex: string; formats?: ColourFormat[] }) {
  const { copy } = useWorkspace(); const values = colourValues(hex);
  return <div className="colour-metrics">{formats.map(format => <button type="button" className="metric" key={format} onClick={() => void copy(values[format])} aria-label={`Copy ${format}: ${values[format]}`}><span className="flex items-center justify-between"><small>{format}</small><Copy size={12} aria-hidden="true" /></span><strong>{values[format]}</strong></button>)}</div>;
}
export function MatchResult({ a, b, deviceDeltaE, sampleSource, matchTarget }: { a: string; b: string; deviceDeltaE?: number; sampleSource?: string; matchTarget?: MatchTargetMetadata }) {
  const difference = deviceDeltaE ?? deltaE(a, b);
  const label = difference < 1 ? 'Match' : difference < 3 ? 'Close Match' : 'Difference detected';
  return <div className="match-result" aria-live="polite" key={`${a}-${b}`}><div className="eyebrow">PERCEPTUAL COLOUR DIFFERENCE</div><div className="delta-number" data-testid="delta-e">{difference.toFixed(2)}<small>ΔE</small></div><h3 className="flex justify-center items-center gap-2">{difference < 3 && <Check size={18} />}{label}</h3><p>{difference < 3 ? 'Your reference and sample are closely aligned.' : 'A visible difference between the reference and sample.'}</p><div className="difference-meter"><i style={{ left: `calc(${Math.min(100, difference / 20 * 100)}% - 6px)` }} /></div><div className="meter-labels"><span>Closer</span><span>Further apart</span></div><p className="match-method">{deviceDeltaE !== undefined ? 'Device-provided ΔE · CHROMA BLE' : 'CIEDE2000 · sRGB / D65'}</p>{sampleSource && <p className="helper">{sampleSource === 'demo' ? 'Simulated demo sample' : sampleSource === 'bluetooth' ? 'Physical sample · Bluetooth' : ['usb', 'wifi'].includes(sampleSource) ? 'Physical sample' : 'Saved or sample colour'}</p>}{matchTarget && <p className="helper match-target-description">Target: {matchTarget.source === 'library' ? 'Library' : 'Image'}{matchTarget.name ? ` · ${matchTarget.name}` : ''}</p>}</div>;
}
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null); const headingId = useId(); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { const dialog = dialogRef.current; const previous = document.activeElement as HTMLElement | null; if (dialog) openModal(dialog); const cancel = (event: Event) => { event.preventDefault(); closeRef.current(); }; dialog?.addEventListener('cancel', cancel); return () => { dialog?.removeEventListener('cancel', cancel); dialog?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  return <dialog ref={dialogRef} className="chroma-modal" aria-labelledby={headingId} onClick={event => { if (event.target === dialogRef.current) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="modal-heading"><h2 id={headingId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</dialog>;
}
export interface PickerOption { value: string; label: string; description?: string; colours?: string[] }

export function ThemedSelect({ id, ariaLabel, title, value, onChange, options, searchable = false, disabled = false }: {
  id?: string; ariaLabel?: string; title: string; value: string; onChange: (value: string) => void;
  options: PickerOption[]; searchable?: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchId = useId();
  const chosen = options.find(option => option.value === value);
  const query = search.trim().toLocaleLowerCase();
  const matches = options.filter(option => `${option.label} ${option.description || ''}`.toLocaleLowerCase().includes(query));
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button id={id} type="button" className="input themed-picker-trigger" aria-label={ariaLabel}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled} data-picker-trigger data-value={value}
      onClick={() => { setSearch(''); setOpen(true); }}>
      <span>{chosen?.label || 'Choose an option…'}</span><ChevronDown size={18} aria-hidden="true" />
    </button>
    {open && <Modal title={title} onClose={() => setOpen(false)}>
      {searchable && <><label className="label" htmlFor={searchId}>Search</label><div className="themed-picker-search">
        <Search size={18} aria-hidden="true" /><input id={searchId} className="input" type="search" autoFocus
          placeholder="Search…" value={search} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
      </div></>}
      <div className="themed-picker-options">
        {matches.map(option => <button key={option.value} type="button" data-choice-value={option.value}
          className={option.value === value ? 'selected' : ''} aria-pressed={option.value === value}
          onClick={() => { onChange(option.value); setOpen(false); }}>
          {option.colours?.length ? <i className="themed-picker-swatch" aria-hidden="true"
            style={{ background: option.colours.length === 1 ? option.colours[0] : `linear-gradient(90deg, ${option.colours[0]} 50%, ${option.colours[1]} 50%)` }} /> : null}
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          {option.value === value && <Check className="themed-picker-check" size={20} aria-hidden="true" />}
        </button>)}
        {!matches.length && <p className="helper" role="status">No matches. Try another search.</p>}
      </div>
    </Modal>}
  </>;
}
export function ProjectSelect({ value, onChange, label = 'Project' }: { value: string; onChange: (value: string) => void; label?: string }) {
  const { workspace } = useWorkspace(); const id = useId();
  return <div className="project-select"><label className="label" htmlFor={id}>{label}</label><ThemedSelect id={id} title="Choose a Project" value={value} onChange={onChange} searchable options={[
    { value: '', label: 'No project · Library only', description: 'Keep this item in your saved Library' },
    ...workspace.projects.map(project => ({ value: project.id, label: project.name })),
  ]} /></div>;
}
export function EmptyState({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><FolderOpen size={28} className="mx-auto text-stone-400" /><h2>{title}</h2><p>{description}</p>{children}</div>;
}
