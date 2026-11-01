import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, Folder, ScanLine, X } from 'lucide-react';
import { useDevice } from '../state/DeviceContext';
import { useWorkspace } from '../state/WorkspaceContext';
import { colorInfo, deltaE, normalizeHex } from '../lib/color';
import { ColourPicker } from '../components/ColourPicker';
import { SavedLibraryPicker } from '../components/SavedLibraryPicker';
import { ColourResult, ComparisonDial, DifferenceRange, colourSourceLabel } from '../components/ColourResult';
import { ProjectSelect } from '../components/ui';
import { exportLibraryFile } from '../services/libraryExport';
import { uid } from '../state/storage';
import { openModal } from '../lib/dialogs';
import type { ColourRecord, ComparisonRecord, MatchTargetMetadata } from '../types';
import './scan-compare-wireframe.css';

type Side = 'a' | 'b';
const captureSources = new Set(['bluetooth', 'usb', 'wifi', 'demo', 'captured', 'device', 'scan']);
export default function ComparePage() {
  const { workspace, compare, setCompare, saveComparison, toast, route, view, navigate, goBack } = useWorkspace();
  const { scanning, scanColour, status, error: deviceError, bleReference, isNative } = useDevice();
  const [inputs, setInputs] = useState({ a: compare.a, b: compare.b });
  const [error, setError] = useState('');
  const [projectId, setProjectId] = useState('');
  const [saved, setSaved] = useState<ComparisonRecord | null>(null);
  const [editTarget, setEditTarget] = useState<Side | null>(null);
  const [libraryTarget, setLibraryTarget] = useState<Side | null>(null);
  const [draftSource, setDraftSource] = useState({ a: compare.referenceSource || compare.matchTarget?.source || 'manual', b: compare.sampleSource || 'manual' });
  const [draftTarget, setDraftTarget] = useState<MatchTargetMetadata | undefined>(compare.matchTarget);
  const editor = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const scanVersion = useRef(0);
  const activeRoute = useRef(route); activeRoute.current = route;
  const [scanTarget, setScanTarget] = useState<Side | null>(null);
  const captures = workspace.history.filter(record => captureSources.has(record.source));
  const devicePair = compare.deviceDeltaE !== undefined;
  const liveReference = bleReference?.hex === compare.a;
  const source = compare.sampleSource || (devicePair ? 'bluetooth' : 'manual');
  const referenceSource = compare.referenceSource || compare.matchTarget?.source || (liveReference || devicePair ? 'bluetooth' : 'manual');
  const waiting = Boolean(compare.waitingForSample);
  const difference = compare.deviceDeltaE ?? deltaE(compare.a, compare.b);
  const resultView = view === 'result';
  const savedPhysical = workspace.comparisons.filter(record => record.deviceDeltaE !== undefined ||
    (captureSources.has(record.sampleSource || '') && (captureSources.has(record.referenceSource || '') ||
      (!record.matchTarget && !record.referenceSource && captures.some(capture => capture.hex === record.a)))));

  useLayoutEffect(() => {
    setInputs({ a: compare.a, b: compare.b }); setSaved(null);
    setDraftSource({ a: compare.referenceSource || compare.matchTarget?.source || 'manual', b: compare.sampleSource || 'manual' }); setDraftTarget(compare.matchTarget);
  }, [compare]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++scanVersion.current; }; }, []);
  useEffect(() => {
    if (!editTarget || libraryTarget) return;
    const element = editor.current;
    const previous = document.activeElement as HTMLElement | null;
    if (element) openModal(element);
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, [editTarget, libraryTarget]);

  function cancelScanSelection() { ++scanVersion.current; setScanTarget(null); }
  function edit(target: Side) {
    cancelScanSelection(); setInputs({ a: compare.a, b: compare.b });
    setDraftSource({ a: referenceSource, b: source }); setDraftTarget(compare.matchTarget);
    setError(''); setEditTarget(target);
  }
  function chooseLibrary(target: Side, id: string) {
    const record = workspace.library.find(item => item.id === id);
    if (!record) return;
    cancelScanSelection();
    setInputs(previous => ({ ...previous, [target]: record.hex })); setDraftSource(previous => ({ ...previous, [target]: 'library' }));
    if (target === 'a') setDraftTarget({ source: 'library', name: record.name, libraryItemId: record.id, libraryProjectId: record.projectId });
  }
  function chooseCapture(target: Side, record: ColourRecord) {
    cancelScanSelection();
    setCompare(target === 'a' ? record.hex : compare.a, target === 'b' ? record.hex : compare.b,
      undefined, target === 'b' ? record.source : source, target === 'a' ? undefined : compare.matchTarget,
      target === 'a' ? record.source : referenceSource);
    setEditTarget(null);
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    try {
      const a = normalizeHex(editor.current?.querySelector<HTMLInputElement>('#compareA')?.value || inputs.a);
      const b = normalizeHex(editor.current?.querySelector<HTMLInputElement>('#compareB')?.value || inputs.b);
      const target = a === inputs.a ? draftTarget : undefined;
      cancelScanSelection();
      setCompare(a, b, undefined, b === inputs.b ? draftSource.b : 'manual', target, a === inputs.a ? draftSource.a : 'manual');
      setError(''); setEditTarget(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Enter a valid colour.'); }
  }
  async function scanSide(target: Side, openResult = false) {
    const version = ++scanVersion.current;
    const pair = { a: compare.a, b: compare.b, source, referenceSource, metadata: compare.matchTarget };
    setScanTarget(target); setEditTarget(null); setError('');
    try {
      const result = await scanColour();
      if (!mounted.current || activeRoute.current !== 'compare' || version !== scanVersion.current) return;
      if (!result) { setError('No colour was received. Check ChromaPod and try again.'); return; }
      setCompare(target === 'a' ? result.hex : pair.a, target === 'b' ? result.hex : pair.b,
        undefined, target === 'b' ? result.source : pair.source, target === 'a' ? undefined : pair.metadata,
        target === 'a' ? result.source : pair.referenceSource);
      if (openResult) navigate('compare', 'result');
    } catch (reason) {
      if (mounted.current && version === scanVersion.current) setError(reason instanceof Error ? reason.message : 'The scan could not be completed.');
    } finally { if (mounted.current && version === scanVersion.current) setScanTarget(null); }
  }
  function save() {
    const record = saveComparison(compare.a, compare.b, projectId || undefined, undefined, compare.deviceDeltaE, source, compare.matchTarget, referenceSource);
    setSaved(record); toast('Comparison saved.');
  }
  async function share() {
    try {
      const reference = colorInfo(compare.a), sample = colorInfo(compare.b);
      const record = { id: saved?.id || uid(), a: compare.a, b: compare.b, name: saved?.name || reference.name + ' & ' + sample.name, createdAt: saved?.createdAt || new Date().toISOString(), projectId: projectId || undefined, ...(compare.deviceDeltaE !== undefined ? { deviceDeltaE: compare.deviceDeltaE } : {}), sampleSource: source, referenceSource, matchTarget: compare.matchTarget, deltaE: difference, method: compare.deviceDeltaE !== undefined ? 'CHROMA BLE device Delta E' : 'CIEDE2000', reference, sample };
      toast(await exportLibraryFile(JSON.stringify({ product: 'CHROMA', version: 2, exportedAt: new Date().toISOString(), colours: [], comparisons: [record], projects: workspace.projects.filter(project => project.id === projectId) }, null, 2), 'image-match'));
    } catch (reason) { toast(reason instanceof Error ? reason.message : 'This comparison could not be shared.'); }
  }
  function showResult() { if (!waiting) navigate('compare', 'result'); }

  if (resultView) return <div className="wireframe-page wireframe-compare compare-result-view"><ColourResult title="Compare Result" reference={compare.a} sample={compare.b} referenceSource={referenceSource} source={source} deviceDeltaE={compare.deviceDeltaE} waiting={waiting} onBack={() => goBack('compare')} backLabel="Back to Compare" onSave={save} onShare={() => void share()} saved={Boolean(saved)} details={<><ProjectSelect value={projectId} onChange={setProjectId} label="Save comparison to" />{compare.matchTarget && <p>Reference: {compare.matchTarget.source === 'library' ? 'Library' : 'Image'}{compare.matchTarget.name ? ' - ' + compare.matchTarget.name : ''}</p>}</>} /></div>;
  return <div className="wireframe-page wireframe-compare">
    <h1 className="sr-only" tabIndex={-1}>Compare</h1><div className="tool-section-heading"><h2>Compare Colours</h2></div>
    <section className="wireframe-compare-pair" aria-label="Your colour pair">{(['a', 'b'] as const).map((key, index) =>
      <button key={key} type="button" className="wireframe-compare-card" data-action={'compare-edit-' + key}
        aria-label={'Edit ' + (index === 0 ? 'reference' : 'sample') + ' colour'} onClick={() => edit(key)}>
        <span className="wireframe-compare-swatch" style={{ backgroundColor: key === 'b' && waiting ? 'var(--surface-soft)' : compare[key] }} />
        <strong>{key === 'b' && waiting ? 'Waiting for sample' : compare[key]}</strong>
        <small>{index === 0 ? 'Reference' : 'Sample'} - {key === 'b' && waiting ? 'ChromaPod' : colourSourceLabel(index === 0 ? referenceSource : source)}</small>
      </button>
    )}</section>
    <p className="compare-physical-instruction">Tap either colour to choose from your Library, use the colour wheel or scan with ChromaPod.</p>
    <ComparisonDial a={compare.a} b={waiting ? 'var(--surface-soft)' : compare.b} difference={difference} waiting={waiting} />
    <DifferenceRange difference={difference} waiting={waiting} device={devicePair} />
    {compare.waitingForSample && <p className="wireframe-compare-waiting" role="status">BLE reference saved. Waiting for a comparison sample from ChromaPod.</p>}
    {(error || deviceError) && <p className="error-message" role="alert">{error || deviceError}</p>}
    {scanTarget && <p className="wireframe-compare-waiting" role="status">
      {isNative && status.mode === 'bluetooth' ? 'Scan on ChromaPod to receive the ' : 'Capturing the '}{scanTarget === 'a' ? 'reference' : 'sample'} colour...
    </p>}
    <div className="compare-primary-actions">
      <button className="btn secondary" type="button" data-action="compare-scan" disabled={scanning || status.mode === 'disconnected'} onClick={() => void scanSide('b', true)}><ScanLine size={17} />{scanTarget === 'b' ? 'Waiting for scan...' : 'Scan sample'}</button>
      <button className="btn primary" type="button" data-action="compare-result" disabled={waiting || Boolean(scanTarget)} onClick={showResult}>Compare</button>
    </div>
    {savedPhysical.length > 0 && <section className="comparison-history"><h2>Previous comparisons</h2>{savedPhysical.slice(0, 6).map(record => <button key={record.id} type="button" onClick={() => {
      cancelScanSelection();
      setCompare(record.a, record.b, record.deviceDeltaE, record.sampleSource || 'bluetooth', record.matchTarget,
        record.referenceSource || (record.deviceDeltaE !== undefined ? 'bluetooth' : captures.find(capture => capture.hex === record.a)?.source || 'captured'));
      navigate('compare', 'result');
    }}><i style={{ background: 'linear-gradient(90deg,' + record.a + ' 50%,' + record.b + ' 50%)' }} /><span><strong>{record.name}</strong><small>{new Date(record.createdAt).toLocaleDateString()}</small></span><ChevronRight size={16} /></button>)}</section>}
    <dialog ref={editor} id="compare-edit" className="chroma-modal compare-colour-editor" aria-labelledby="compare-editor-title" onCancel={event => { event.preventDefault(); setEditTarget(null); }}>
      <div className="modal-heading"><h2 id="compare-editor-title">{editTarget === 'b' ? 'Sample colour' : 'Reference colour'}</h2><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => setEditTarget(null)}><X size={18} /></button></div>
      <form id="compare-form" onSubmit={apply}>{(['a', 'b'] as const).map(key => <div key={key} hidden={editTarget !== key}>
        <div className="compare-colour-source-actions">
          <button className="btn secondary" type="button" data-action={'compare-library-' + key} aria-haspopup="dialog" onClick={() => setLibraryTarget(key)}><Folder size={18} />Saved Library</button>
          <button className="btn secondary" type="button" data-action={'compare-scan-' + key} disabled={scanning || status.mode === 'disconnected'} onClick={() => void scanSide(key)}><ScanLine size={18} />Scan {key === 'a' ? 'reference' : 'sample'}</button>
        </div>
        {status.mode === 'disconnected' && <p className="helper">Connect ChromaPod or enable demo mode to scan.</p>}
        <ColourPicker value={inputs[key]} id={'compare-picker-' + key} hexId={'compare' + key.toUpperCase()} name={key === 'a' ? 'Reference colour wheel' : 'Sample colour wheel'} onChange={hex => {
          cancelScanSelection(); setInputs(previous => ({ ...previous, [key]: hex }));
          setDraftSource(previous => ({ ...previous, [key]: 'manual' })); if (key === 'a') setDraftTarget(undefined);
        }} />
        <details className="compare-capture-options"><summary>Recent scans{captures.length ? ' (' + captures.length + ')' : ''}</summary>
          {captures.map(record => <button className="compare-capture-choice" key={record.id} type="button" onClick={() => chooseCapture(key, record)}><i style={{ background: record.hex }} /><span><strong>{record.name}</strong><small>{record.hex} - {colourSourceLabel(record.source)}</small></span></button>)}
          {!captures.length && <p>No captured readings yet.</p>}
        </details>
      </div>)}{error && <p className="error-message" role="alert">{error}</p>}<button className="btn primary full-width" type="submit">Use colour</button></form>
    </dialog>
    {libraryTarget && <SavedLibraryPicker searchId="compare-library-search" onClose={() => setLibraryTarget(null)}
      onChoose={record => { chooseLibrary(libraryTarget, record.id); setLibraryTarget(null); }}
      onOpenLibrary={() => { setLibraryTarget(null); setEditTarget(null); navigate('library'); }} />}
  </div>;
}
