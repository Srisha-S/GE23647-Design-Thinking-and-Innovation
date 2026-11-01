import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Brush, Camera, Check, Download, Eraser, ImagePlus, Lightbulb, LoaderCircle, MousePointer2, Paintbrush, RefreshCw, Settings2, Share2, Snowflake, Sun, Trash2, Undo2, X } from 'lucide-react';
import { useWorkspace } from '../../state/WorkspaceContext';
import { ColourMetrics, Modal, PageHeading, ThemedSelect } from '../../components/ui';
import { SavedLibrarySelect } from '../../components/SavedLibraryPicker';
import { colorInfo } from '../../lib/color';
import { VisualizeCanvas } from './VisualizeCanvas';
import { ManualMaskProvider, type SelectionMode } from './maskProvider';
import { resizeMask, type BrushMode, type Point } from './mask';
import { buildRecolourAsync, blendIntensity, type ImagePixels } from './recolor';
import { LIGHTING_PRESETS, MATERIAL_PROFILES, type LightingMode, type MaterialType } from './materialProfiles';
import { createSegmentationProvider, segmentationConfiguration, type SelectionEngine } from './segmentationProviders';
import { CloudSelectionError, type CloudSelectionProgress } from './cloudSam3Client';
import { getExportDimensions, loadVisualizeImage, renderOriginalPixels, type WorkingImage } from './imageUtils';
import { exportPreview } from './exportPreview';
import { hasLatestScan, previewMetadata, snapshotTarget, type VisualizeColourSource, type VisualizeTarget } from './visualizeTypes';
import './visualize.css';

const SERVER_KEY = 'chroma-visualize-sam3-v1';
function initialServerUrl(): string {
  if (!segmentationConfiguration.development) return '';
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SERVER_KEY) || 'null');
    if (stored && typeof stored === 'object' && 'url' in stored && typeof stored.url === 'string' && stored.url.length < 2048) return stored.url;
  } catch { /* Invalid preferences never affect saved workspace data. */ }
  return segmentationConfiguration.localServerUrl;
}
function validServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS address without credentials, a query or a fragment.');
  return url.href.replace(/\/+$/, '');
}

export default function VisualizePage({ active = true }: { active?: boolean }) {
  const { workspace, navigate, toast } = useWorkspace();
  const [target, setTarget] = useState<VisualizeTarget | null>(() => hasLatestScan(workspace.latest) ? snapshotTarget(workspace.latest, 'Latest Scan') : null);
  const [source, setSource] = useState<VisualizeColourSource>('Latest Scan');
  const [choosing, setChoosing] = useState(!target);
  const [image, setImage] = useState<WorkingImage | null>(null);
  const [provider, setProvider] = useState<ManualMaskProvider | null>(null);
  const [maskVersion, setMaskVersion] = useState(0);
  const [tool, setTool] = useState<BrushMode | 'tap'>('tap');
  const [brushSize, setBrushSize] = useState(28);
  const [painting, setPainting] = useState(false);
  const [editing, setEditing] = useState(true);
  const [material, setMaterial] = useState<MaterialType>('fabric');
  const [lighting, setLighting] = useState<LightingMode>('daylight');
  const [intensity, setIntensity] = useState(100);
  const [view, setView] = useState<'before' | 'after' | 'compare'>('compare');
  const [wipe, setWipe] = useState(50);
  const [transformed, setTransformed] = useState<ImagePixels | null>(null);
  const [preview, setPreview] = useState<ImagePixels | null>(null);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  const [selectionEngine, setSelectionEngine] = useState<SelectionEngine>(segmentationConfiguration.defaultEngine);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('replace');
  const [tolerance, setTolerance] = useState(24);
  const [selectionMessage, setSelectionMessage] = useState('');
  const [selectionProgress, setSelectionProgress] = useState<CloudSelectionProgress | null>(null);
  const [selectionFailed, setSelectionFailed] = useState(false);
  const [canRetrySelection, setCanRetrySelection] = useState(false);
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [serverOpen, setServerOpen] = useState(false);
  const [serverError, setServerError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const imageRef = useRef<WorkingImage | null>(null);
  const loadVersion = useRef(0);
  const renderVersion = useRef(0);
  const selectionVersion = useRef(0);
  const renderAbort = useRef<AbortController | null>(null);
  const renderActivity = useRef<'preview' | 'export' | null>(null);
  const selectionAbort = useRef<AbortController | null>(null);
  const lastSelectionPoint = useRef<Point | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const currentLibrary = useRef(workspace.library); currentLibrary.current = workspace.library;
  const lastLibraryHash = useRef('');
  const busy = loading || processing || exporting || painting || selecting;
  const selectedCount = useMemo(() => provider?.mask.data.reduce((count, alpha) => count + (alpha > 0 ? 1 : 0), 0) || 0, [provider, maskVersion]);
  const selected = selectedCount > 0;
  const outputSize = image ? getExportDimensions(image.naturalWidth, image.naturalHeight) : null;
  const materialInfo = MATERIAL_PROFILES.find(item => item.id === material)!;
  const lightingInfo = LIGHTING_PRESETS.find(item => item.id === lighting)!;

  function invalidate() {
    ++renderVersion.current; renderAbort.current?.abort();
    renderActivity.current = null;
    setProcessing(false); setTransformed(null); setPreview(null); setEditing(true); setError('');
  }
  function cancelSelection() {
    ++selectionVersion.current; selectionAbort.current?.abort(); selectionAbort.current = null; setSelecting(false); setSelectionProgress(null);
  }
  function chooseTarget(next: VisualizeTarget) {
    invalidate(); setTarget(next); setSource(next.colourSource); setChoosing(false);
  }
  useEffect(() => {
    const readLibraryTarget = () => {
      const hash = location.hash;
      if (!hash.startsWith('#visualize/library/') || lastLibraryHash.current === hash) return;
      let id: string;
      try { id = decodeURIComponent(hash.slice('#visualize/library/'.length)); } catch { return; }
      const colour = currentLibrary.current.find(item => item.id === id);
      lastLibraryHash.current = hash;
      if (colour) chooseTarget(snapshotTarget(colour, 'Library'));
      else setError('This Library colour is no longer available. Choose another colour.');
    };
    readLibraryTarget(); window.addEventListener('hashchange', readLibraryTarget);
    return () => window.removeEventListener('hashchange', readLibraryTarget);
  }, []);
  useEffect(() => {
    if (!active) {
      lastLibraryHash.current = ''; cancelSelection(); setServerOpen(false);
      ++loadVersion.current; setLoading(false);
      if (renderActivity.current) {
        ++renderVersion.current; renderAbort.current?.abort();
        if (renderActivity.current === 'preview') { setTransformed(null); setPreview(null); setEditing(true); }
        renderActivity.current = null; setProcessing(false); setExporting(false);
      }
    }
  }, [active]);
  useEffect(() => () => {
    ++loadVersion.current; ++renderVersion.current; ++selectionVersion.current;
    renderAbort.current?.abort(); selectionAbort.current?.abort();
    imageRef.current?.dispose(); imageRef.current = null;
  }, []);
  useEffect(() => {
    if (!image || !transformed) { setPreview(null); return; }
    const frame = requestAnimationFrame(() => setPreview(blendIntensity(image.pixels, transformed, intensity)));
    return () => cancelAnimationFrame(frame);
  }, [image, transformed, intensity]);

  async function upload(file?: File) {
    if (!file || busy) return;
    cancelSelection();
    const version = ++loadVersion.current; setLoading(true); setError('');
    try {
      const next = await loadVisualizeImage(file);
      if (version !== loadVersion.current) { next.dispose(); return; }
      invalidate(); imageRef.current?.dispose(); imageRef.current = next;
      setImage(next); setProvider(new ManualMaskProvider(next.width, next.height)); setMaskVersion(0);
      setIntensity(100); setTool('tap'); setView('compare'); setWipe(50); setPainting(false);
      setSelectionMessage('');
      setSelectionFailed(false); setCanRetrySelection(false); lastSelectionPoint.current = null;
    } catch (reason) {
      if (version === loadVersion.current) setError(reason instanceof Error ? reason.message : 'This photo could not be opened.');
    } finally { if (version === loadVersion.current) setLoading(false); }
  }
  function removeImage() {
    ++loadVersion.current; cancelSelection(); invalidate(); imageRef.current?.dispose(); imageRef.current = null;
    setImage(null); setProvider(null); setLoading(false); setMaskVersion(0); setPainting(false); setSelectionMessage('');
    setSelectionFailed(false); setCanRetrySelection(false); lastSelectionPoint.current = null;
  }
  function maskChanged() {
    setMaskVersion(version => version + 1); setSelectionFailed(false); setCanRetrySelection(false); invalidate();
    setSelectionMessage(selectionStatus(provider));
  }
  function selectionStatus(selectedProvider: ManualMaskProvider | null): string {
    if (!selectedProvider?.mask.data.some(Boolean)) return '';
    const { selectionMethod, selectionRefined } = selectedProvider.provenance;
    if (selectionRefined) return 'Selection refined. Choose the material and refine edges if needed.';
    if (selectionMethod === 'local-region') return 'Local region selected. Check the blue area; use Brush or Eraser to refine it.';
    if (selectionMethod === 'sam3') return segmentationConfiguration.development && selectionEngine === 'sam3'
      ? 'SAM 3 selection ready. Choose the material and refine edges if needed.'
      : 'Surface selected. Choose the material and refine edges if needed.';
    return 'Manual selection ready. Choose the material and refine edges if needed.';
  }
  async function selectSurface(point: Point) {
    if (!image || !provider || busy || !active || selectionAbort.current) return;
    const version = ++selectionVersion.current;
    const controller = new AbortController(); selectionAbort.current = controller;
    const selectedImage = image; const selectedProvider = provider;
    lastSelectionPoint.current = point;
    setSelecting(true); setError(''); setSelectionMessage(''); setSelectionFailed(false); setCanRetrySelection(false); setSelectionProgress(null);
    try {
      const automaticProvider = createSegmentationProvider(selectionEngine, { ...segmentationConfiguration, localServerUrl: serverUrl });
      const mask = await automaticProvider.select(image.pixels, point, { tolerance, signal: controller.signal, onProgress: progress => {
        if (version === selectionVersion.current && !controller.signal.aborted && activeRef.current) setSelectionProgress(progress);
      } });
      if (version !== selectionVersion.current || controller.signal.aborted || imageRef.current !== selectedImage || !activeRef.current) return;
      const changed = selectedProvider.applySelection(mask, selectionMode, automaticProvider.selectionMethod);
      if (changed) { setMaskVersion(value => value + 1); invalidate(); }
      setSelectionMessage(selectionStatus(selectedProvider));
    } catch (reason) {
      if (version === selectionVersion.current && !controller.signal.aborted && activeRef.current) {
        setError(reason instanceof Error ? reason.message : 'Auto Select is temporarily unavailable.');
        setSelectionFailed(true); setCanRetrySelection(!(reason instanceof CloudSelectionError) || reason.retryable);
      }
    } finally {
      if (version === selectionVersion.current) { selectionAbort.current = null; setSelecting(false); setSelectionProgress(null); }
    }
  }
  function selectManually() {
    cancelSelection(); setTool('brush'); setEditing(true); setError(''); setSelectionFailed(false); setCanRetrySelection(false);
    setSelectionMessage('Brush the surface to select it, then use Eraser to refine the edges.');
  }
  async function applyColour(nextMaterial = material, nextLighting = lighting) {
    if (!image || !provider || !target || !selected || loading || exporting || painting || selecting) return;
    const version = ++renderVersion.current;
    const controller = new AbortController(); renderAbort.current?.abort(); renderAbort.current = controller;
    renderActivity.current = 'preview';
    setProcessing(true); setError('');
    try {
      const result = await buildRecolourAsync(image.pixels, provider.mask, target.colour.hex, { signal: controller.signal, material: nextMaterial, lighting: nextLighting, targetLab: colorInfo(target.colour.hex).lab });
      if (version !== renderVersion.current) return;
      setTransformed(result); setEditing(false);
    } catch (reason) {
      if (!controller.signal.aborted && version === renderVersion.current) {
        setTransformed(null); setPreview(null); setEditing(true);
        setError(reason instanceof Error ? reason.message : 'The preview could not be created.');
      }
    } finally { if (version === renderVersion.current) { setProcessing(false); renderActivity.current = null; } }
  }
  function changeMaterial(next: MaterialType) {
    if (next === material) return;
    setMaterial(next); if (!editing && transformed) void applyColour(next, lighting); else invalidate();
  }
  function changeLighting(next: LightingMode) {
    if (next === lighting) return;
    setLighting(next); if (!editing && transformed) void applyColour(material, next); else invalidate();
  }
  function saveServer() {
    try {
      const value = validServerUrl(serverDraft); setServerUrl(value); setServerError('');
      try { localStorage.setItem(SERVER_KEY, JSON.stringify({ version: 1, url: value })); } catch { /* In-memory configuration still works. */ }
      setServerOpen(false); toast('SAM 3 server address saved.');
    } catch (reason) { setServerError(reason instanceof Error ? reason.message : 'Check the server address.'); }
  }
  async function savePreview(mode: 'save' | 'share') {
    if (!image || !provider || !target || !transformed || !outputSize || busy || editing) return;
    setExporting(true); setError('');
    const controller = new AbortController(); renderAbort.current = controller;
    const version = ++renderVersion.current; renderActivity.current = 'export';
    let outputCanvas: HTMLCanvasElement | null = null;
    try {
      const original = renderOriginalPixels(image, outputSize.width, outputSize.height);
      const mask = resizeMask(provider.mask, outputSize.width, outputSize.height);
      const coloured = await buildRecolourAsync(original, mask, target.colour.hex, { signal: controller.signal, material, lighting, targetLab: colorInfo(target.colour.hex).lab });
      const result = blendIntensity(original, coloured, intensity);
      outputCanvas = document.createElement('canvas'); outputCanvas.width = outputSize.width; outputCanvas.height = outputSize.height;
      const context = outputCanvas.getContext('2d');
      if (!context) throw new Error('Image export is unavailable on this device.');
      context.putImageData(new ImageData(result.data as Uint8ClampedArray<ArrayBuffer>, outputSize.width, outputSize.height), 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => outputCanvas!.toBlob(value => value ? resolve(value) : reject(new Error('The PNG could not be created.')), 'image/png'));
      outputCanvas.width = 0; outputCanvas.height = 0; outputCanvas = null;
      if (controller.signal.aborted || !activeRef.current || version !== renderVersion.current) return;
      const metadata = previewMetadata(target, image, intensity, outputSize, { material, lighting, ...provider.provenance });
      const message = await exportPreview(blob, metadata, mode, {}, controller.signal);
      if (!controller.signal.aborted && activeRef.current) toast(message);
    } catch (reason) { if (!controller.signal.aborted && version === renderVersion.current) setError(reason instanceof Error ? reason.message : 'The image could not be exported.'); }
    finally { if (outputCanvas) { outputCanvas.width = 0; outputCanvas.height = 0; } if (version === renderVersion.current) { setExporting(false); renderActivity.current = null; } }
  }

  return <div className="visualize-page">
    <PageHeading eyebrow="REAL COLOUR, NEW POSSIBILITIES" title="Visualize" description="Try your colour on a real surface. Keep its texture, explore the light." />
    <section className="panel visualize-photo-panel" aria-labelledby="visualize-photo-heading">
      <div className="panel-heading"><h2 id="visualize-photo-heading"><span className="visualize-step">1</span>Choose Photo</h2>{image && <button className="icon-button" aria-label="Remove Visualize photo" disabled={busy} onClick={removeImage}><X size={18} /></button>}</div>
      <input hidden ref={fileInput} type="file" id="visualize-photo-input" accept="image/jpeg,image/png,image/webp" aria-label="Choose Visualize photo" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
      <input hidden ref={cameraInput} type="file" id="visualize-camera-input" accept="image/*" capture="environment" aria-label="Capture Visualize photo" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
      {image ? <div className="visualize-photo-info"><img src={image.url} alt="Your original photo" /><div><strong>{image.name}</strong><p>{image.naturalWidth} × {image.naturalHeight} pixels</p><div className="button-row"><button className="btn secondary" disabled={busy} onClick={() => fileInput.current?.click()}><ImagePlus size={16} />Replace Photo</button><button className="btn secondary" disabled={busy} onClick={() => cameraInput.current?.click()}><Camera size={16} />Camera</button></div></div></div> : <div className="visualize-upload" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}><ImagePlus size={28} /><h3>A new colour, in your space.</h3><p>Choose a photo of an object or surface.</p><div className="button-row"><button className="btn primary" disabled={busy} onClick={() => fileInput.current?.click()}><ImagePlus size={17} />{loading ? 'Opening photo…' : 'Choose Photo'}</button><button className="btn secondary" disabled={busy} onClick={() => cameraInput.current?.click()}><Camera size={17} />Camera</button></div><small>JPEG, PNG or WEBP · up to 20 MB</small></div>}
      <p className="helper">Tap a surface, choose its material, then preview your scanned or saved colour.</p>
    </section>
    {image && provider && <section className="panel visualize-workspace" aria-labelledby="visualize-workspace-heading" aria-busy={processing || exporting || selecting}>
      <div className="panel-heading"><h2 id="visualize-workspace-heading"><span className="visualize-step">{editing ? '2' : '5'}</span>{editing ? 'Select a Surface' : 'Your Colour Preview'}</h2>{editing ? <span className="badge">{tool === 'tap' ? selectionEngine === 'cloud' ? 'Auto Select' : selectionEngine === 'sam3' ? 'SAM 3 selection' : 'Local tap selection' : 'Manual selection'}</span> : <div className="format-tabs visualize-view-tabs" role="group" aria-label="Before and after">{(['before', 'after', 'compare'] as const).map(item => <button type="button" key={item} className={view === item ? 'active' : ''} aria-pressed={view === item} disabled={busy} onClick={() => setView(item)}>{item === 'before' ? 'Before' : item === 'after' ? 'After' : 'Slider'}</button>)}</div>}</div>
      {editing && <>
        <div className="visualize-mask-toolbar"><div className="format-tabs visualize-tool-tabs" role="group" aria-label="Selection tools">
          <button type="button" aria-pressed={tool === 'tap'} className={tool === 'tap' ? 'active' : ''} disabled={busy} onClick={() => setTool('tap')}><MousePointer2 size={16} />Auto Select</button>
          <button type="button" aria-pressed={tool === 'brush'} className={tool === 'brush' ? 'active' : ''} disabled={busy} onClick={() => setTool('brush')}><Brush size={16} />Brush</button>
          <button type="button" aria-pressed={tool === 'eraser'} className={tool === 'eraser' ? 'active' : ''} disabled={busy} onClick={() => setTool('eraser')}><Eraser size={16} />Eraser</button>
        </div>{tool !== 'tap' && <label className="visualize-range" htmlFor="visualize-brush-size"><span>Brush size <strong>{brushSize}px</strong></span><input id="visualize-brush-size" type="range" min="4" max="96" step="2" value={brushSize} disabled={busy} onChange={event => setBrushSize(Number(event.target.value))} /></label>}<div className="button-row"><button className="btn secondary" disabled={busy || !provider.canUndo} onClick={() => { if (provider.undo()) maskChanged(); }}><Undo2 size={16} />Undo</button><button className="btn secondary" disabled={busy || !selected} onClick={() => { if (provider.clear()) maskChanged(); }}><Trash2 size={16} />Clear Selection</button></div></div>
        {tool === 'tap' && <div className="visualize-selection-options"><div><label className="label" htmlFor="visualize-selection-engine">Tap selection</label><ThemedSelect id="visualize-selection-engine" title="Tap selection" value={selectionEngine} disabled={busy} onChange={value => { setSelectionEngine(value as SelectionEngine); setError(''); setSelectionMessage(''); setSelectionFailed(false); setCanRetrySelection(false); }} options={[{ value: 'cloud', label: 'Auto Select' }, { value: 'local', label: 'On-device colour region' }, ...(segmentationConfiguration.development ? [{ value: 'sam3', label: 'SAM 3 object (development)' }] : [])]} /></div><div><label className="label" htmlFor="visualize-selection-mode">Selection action</label><ThemedSelect id="visualize-selection-mode" title="Selection action" value={selectionMode} disabled={busy} onChange={value => setSelectionMode(value as SelectionMode)} options={[{ value: 'replace', label: 'Replace selection' }, { value: 'add', label: 'Add to selection' }, { value: 'remove', label: 'Remove from selection' }]} /></div>
          {selectionEngine === 'local' ? <label className="visualize-range" htmlFor="visualize-tolerance"><span>Region tolerance <strong>{tolerance}</strong></span><input id="visualize-tolerance" type="range" min="1" max="80" value={tolerance} disabled={busy} onChange={event => setTolerance(Number(event.target.value))} /></label> : segmentationConfiguration.development && selectionEngine === 'sam3' ? <button className="btn secondary" disabled={busy} onClick={() => { setServerDraft(serverUrl); setServerError(''); setServerOpen(true); }}><Settings2 size={16} />SAM 3 server</button> : null}
          <p className="helper">{selectionEngine === 'local' ? 'Selects a connected colour region on this device. Use Brush and Eraser for complex edges.' : selectionEngine === 'cloud' ? 'Tap sends a resized copy of this photo for object selection. An internet connection is needed.' : 'Tap sends the working photo to your development SAM 3 server.'}</p>
        </div>}
      </>}
      <VisualizeCanvas image={image} provider={provider} maskVersion={maskVersion} pixels={!editing && view === 'after' ? preview : null} comparison={!editing && view === 'compare' && preview ? { pixels: preview, position: wipe } : undefined} editing={editing} active={active} disabled={loading || processing || exporting || selecting} tool={tool} brushSize={brushSize} onChange={maskChanged} onPaintingChange={setPainting} onSurfaceTap={point => void selectSurface(point)} />
      <p className="visualize-canvas-caption">{editing ? tool === 'tap' ? 'Tap the surface. Review the blue selection before applying.' : 'Brush the surface; erase spill at the edges.' : materialInfo.label + ' · ' + lightingInfo.label + ' · ' + target?.colour.hex + ' at ' + intensity + '%'}</p>
      {selecting && <p className="helper visualize-progress" role="status"><LoaderCircle size={16} className="animate-spin" />{selectionEngine === 'cloud' ? cloudProgressLabel(selectionProgress) : selectionEngine === 'sam3' ? 'SAM 3 is selecting the object…' : 'Selecting the local colour region…'}<button className="text-button" onClick={cancelSelection}>Cancel</button></p>}
      {selectionFailed && editing && <><p className="error-message visualize-error" role="alert">{error}</p><div className="button-row visualize-selection-fallback"><button className="btn primary" disabled={busy} onClick={selectManually}><Brush size={16} />Select manually</button>{canRetrySelection && lastSelectionPoint.current && <button className="btn secondary" disabled={busy} onClick={() => { if (lastSelectionPoint.current) void selectSurface(lastSelectionPoint.current); }}><RefreshCw size={16} />Retry Auto Select</button>}<button className="btn secondary" disabled={busy} onClick={() => { setSelectionEngine('local'); setTool('tap'); setError(''); setSelectionFailed(false); setSelectionMessage('Tap a connected colour region. This selection works on your device.'); }}>Use on-device selection</button></div></>}
      {selectionMessage && editing && <p className="helper" role="status" data-testid="visualize-selection-status">{selectionMessage}</p>}
      {editing && selected && <p className="helper visualize-selection-count">{selectedCount.toLocaleString()} pixels selected · choose the material below</p>}
      {!editing && view === 'compare' && <label className="visualize-range visualize-wipe" htmlFor="visualize-wipe"><span>Original <strong>Preview</strong></span><input id="visualize-wipe" type="range" min="0" max="100" value={wipe} disabled={busy} onChange={event => setWipe(Number(event.target.value))} aria-label="Before and after split position" /></label>}
      {!editing && <label className="visualize-range visualize-intensity" htmlFor="visualize-intensity"><span>Colour Intensity <strong>{intensity}%</strong></span><input id="visualize-intensity" type="range" min="0" max="100" step="1" value={intensity} disabled={busy} onChange={event => setIntensity(Number(event.target.value))} /></label>}
    </section>}
    <div className="visualize-setup visualize-appearance-setup">
      <section className="panel visualize-material-panel" aria-labelledby="visualize-material-heading"><div className="panel-heading"><h2 id="visualize-material-heading"><span className="visualize-step">3</span>Material</h2></div>
        <div className="visualize-material-options" role="group" aria-label="Surface material">{MATERIAL_PROFILES.map(profile => <button className={material === profile.id ? 'active' : ''} type="button" key={profile.id} data-material={profile.id} aria-pressed={material === profile.id} disabled={busy} onClick={() => changeMaterial(profile.id)}>{profile.label}</button>)}</div>
        <p className="helper" data-testid="visualize-material-description">{materialInfo.description}. Choose the actual surface material.</p>
        <div className="visualize-lighting-heading"><Lightbulb size={18} /><h3>LightShift</h3></div>
        <div className="visualize-lighting-options" role="group" aria-label="Lighting preview">{LIGHTING_PRESETS.map(preset => <button className={lighting === preset.id ? 'active' : ''} type="button" key={preset.id} data-lighting={preset.id} aria-pressed={lighting === preset.id} disabled={busy} onClick={() => changeLighting(preset.id)}>{preset.id === 'daylight' ? <Sun size={18} /> : preset.id === 'cool' ? <Snowflake size={18} /> : <Lightbulb size={18} />}<strong>{preset.label}</strong><small>{preset.kelvin}K</small></button>)}</div>
        <p className="helper visualize-approximation">Lighting is an approximate colour cast on the selected surface. Your original photo and scanned value stay unchanged.</p>
      </section>
      <section className="panel visualize-colour-panel" aria-labelledby="visualize-colour-heading">
        <div className="panel-heading"><h2 id="visualize-colour-heading"><span className="visualize-step">4</span>{transformed && !editing ? 'Applied Colour' : 'Select Colour'}</h2>{target && <button className="text-button" disabled={busy} onClick={() => setChoosing(value => !value)}>{choosing ? 'Done' : 'Change Colour'}<RefreshCw size={14} /></button>}</div>
        {choosing && <div className="visualize-colour-chooser">
          <div className="format-tabs visualize-source-tabs" role="group" aria-label="Visualize colour source">{(['Latest Scan', 'Library'] as const).map(item => <button type="button" key={item} aria-pressed={source === item} className={source === item ? 'active' : ''} disabled={busy} onClick={() => setSource(item)}>{item}</button>)}</div>
          {source === 'Latest Scan' ? hasLatestScan(workspace.latest) ? <div className="visualize-latest"><span style={{ background: workspace.latest.hex }} /><div><strong>{workspace.latest.name}</strong><small>{workspace.latest.hex} · {workspace.latest.source === 'demo' ? 'Simulated demo scan' : `${workspace.latest.source.toUpperCase()} scan`}</small><time dateTime={workspace.latest.createdAt}>{new Date(workspace.latest.createdAt).toLocaleString()}</time></div><button className="btn secondary" disabled={busy} onClick={() => chooseTarget(snapshotTarget(workspace.latest, 'Latest Scan'))}>Use scan</button></div> : <div className="visualize-empty"><p>No scan yet. Scan a surface with CHROMAPOD or try a demo scan.</p><button className="btn secondary" onClick={() => navigate('scan')}>Open Scan<ArrowRight size={15} /></button></div> : <div><label className="label" htmlFor="visualize-library-colour">Saved Library colour</label><SavedLibrarySelect id="visualize-library-colour" value={target?.colourSource === 'Library' ? target.libraryItemId : ''} disabled={busy} onChoose={colour => chooseTarget(snapshotTarget(colour, 'Library'))} onOpenLibrary={() => navigate('library')} />{!workspace.library.length && <button className="text-button" onClick={() => navigate('library')}>Open Library<ArrowRight size={14} /></button>}</div>}
        </div>}
        {target && <div className="visualize-selected-colour" data-testid="visualize-target"><div className="visualize-target-summary"><span className="visualize-target-swatch" style={{ background: target.colour.hex }} /><div><h3>{target.colour.name}</h3><strong>{target.colour.hex}</strong><p>Source: {target.colourSource}{target.colourSource === 'Latest Scan' && target.colour.source === 'demo' ? ' · Demo' : ''}</p></div></div><ColourMetrics hex={target.colour.hex} formats={['RGB', 'LAB']} /><details className="visualize-source-details"><summary>Colour details</summary><dl><div><dt>Recorded</dt><dd><time dateTime={target.colour.createdAt}>{new Date(target.colour.createdAt).toLocaleString()}</time></dd></div><div><dt>Original source</dt><dd>{target.colour.source}</dd></div><div><dt>{target.libraryItemId ? 'Library ID' : 'Reading ID'}</dt><dd>{target.colour.id}</dd></div>{target.colour.clear !== undefined && <div><dt>Clear channel</dt><dd>{target.colour.clear}</dd></div>}{target.colour.projectId && <div><dt>Project</dt><dd>{workspace.projects.find(project => project.id === target.colour.projectId)?.name || target.colour.projectId}</dd></div>}</dl></details></div>}
      </section>
    </div>
    {image && provider && <section className="panel visualize-preview-actions" aria-label="Preview actions">
      {editing ? <div className="visualize-apply-row"><p className="helper">{!target ? 'Choose a colour to continue.' : !selected ? 'Tap or brush a surface to continue.' : 'Ready to preview. Only the blue selection will change.'}</p>{transformed && <button className="btn secondary" disabled={busy} onClick={() => setEditing(false)}>Back to Preview</button>}<button className="btn primary" disabled={busy || !target || !selected} onClick={() => void applyColour()}><Paintbrush size={17} />{processing ? 'Applying colour…' : 'Apply Colour'}</button></div> : <><div className="button-row visualize-result-actions"><button className="btn secondary" disabled={busy} onClick={() => setEditing(true)}><Brush size={16} />Edit Selection</button><button className="btn secondary" disabled={busy} onClick={() => { setChoosing(true); document.getElementById('visualize-colour-heading')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>Change Colour</button><button className="btn primary" disabled={busy} onClick={() => void savePreview('save')}><Download size={16} />{exporting ? 'Preparing image…' : 'Save Preview'}</button><button className="btn secondary" disabled={busy} onClick={() => void savePreview('share')}><Share2 size={16} />Share</button></div><p className="helper"><Check size={13} />PNG export: {outputSize?.width} × {outputSize?.height} pixels · colour, material and lighting metadata</p></>}
      <details className="visualize-help"><summary>Selection and preview tips</summary><p>Auto Select chooses objects from a tap. On-device colour region chooses connected colours and also works offline. Correct either with Brush, Eraser, Add, Remove and Undo.</p><p>Keyboard: focus the photo, use arrow keys to move the point, then Enter to select or Space to paint. Ctrl/⌘ Z undoes.</p><p>Material profiles preserve existing texture and shading. LightShift is an approximate cast; screen calibration and lighting affect colour. This is a photographic preview, not a material or print proof.</p><p>Exports use the original photo up to 8 megapixels and a 4096-pixel longest edge.</p></details>
    </section>}
    {error && !(selectionFailed && image && editing) && <p className="error-message visualize-error" role="alert">{error}</p>}
    {(loading || processing || exporting) && <p className="helper visualize-progress" role="status"><LoaderCircle size={16} className="animate-spin" />{loading ? 'Opening photo…' : processing ? 'Preserving texture and applying your colour…' : 'Rendering your image export…'}</p>}
    {segmentationConfiguration.development && serverOpen && <Modal title="SAM 3 server" onClose={() => setServerOpen(false)}><p className="helper">Run the included local SAM 3 server with approved weights, then enter its address. On Android, localhost needs USB forwarding to your computer.</p><label className="label" htmlFor="visualize-server-url">Server address</label><input id="visualize-server-url" className="input" type="url" value={serverDraft} onChange={event => setServerDraft(event.target.value)} placeholder="http://127.0.0.1:8001" /><p className="helper">Only a tap in SAM 3 mode sends the working photo to this address. Local region selection and manual editing stay on this device.</p>{serverError && <p className="error-message" role="alert">{serverError}</p>}<button className="btn primary full-width" onClick={saveServer}>Save server address</button></Modal>}
  </div>;
}

function cloudProgressLabel(progress: CloudSelectionProgress | null): string {
  if (progress?.state === 'connecting') return 'Connecting…';
  if (progress?.state === 'uploading') return 'Uploading photo…';
  if (progress?.state === 'queued') return typeof progress.position === 'number' && progress.position >= 0
    ? `Queued for selection${progress.position > 0 ? ` · ${progress.position} ahead` : ''}…` : 'Queued for selection…';
  return 'Selecting surface…';
}
