import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bookmark, Copy, Folder, LoaderCircle, MoreHorizontal, Palette, ScanLine, Share2 } from 'lucide-react';
import { colorInfo, generatePalette } from '../lib/color';
import { withColourRenderContext } from '../lib/runtimeDiagnostics';
import { parseConvertInput } from '../lib/convertInput';
import { useWorkspace } from '../state/WorkspaceContext';
import { useDevice } from '../state/DeviceContext';
import { ColourMetrics, Modal, ProjectSelect, ThemedSelect } from '../components/ui';
import { PageHeaderSlots } from '../components/PageHeaderSlots';
import { ColourPicker } from '../components/ColourPicker';
import { SavedLibraryPicker } from '../components/SavedLibraryPicker';
import { colourSourceLabel } from '../components/ColourResult';
import type { ColourFormat } from '../types';
import './convert-image-wireframe.css';

const formats: ColourFormat[] = ['HEX', 'RGB', 'HSL', 'LAB', 'CMYK'];
type ColourOrigin = { kind: 'library'; id: string; name: string } | { kind: 'scan'; source: string; timestamp: string };
const hints: Record<ColourFormat, string> = {
  HEX: 'Enter 6 hexadecimal digits, with or without #.',
  RGB: 'Red, green, blue: each from 0 to 255.',
  HSL: 'Hue: 0–360°. Saturation and lightness: 0–100%.',
  LAB: 'L*: 0–100. a* and b*: −128 to 127. Out-of-gamut values are clipped to sRGB.',
  CMYK: 'Cyan, magenta, yellow, black: each from 0 to 100%.',
};

function inputValues(hex: string): Record<ColourFormat, string> {
  const colour = colorInfo(hex);
  const precise = (values: number[]) => values.map(value => Number(value.toFixed(6))).join(', ');
  return { HEX: colour.hex, RGB: precise(Object.values(colour.rgb)), HSL: precise(Object.values(colour.hsl)), LAB: precise(Object.values(colour.lab)), CMYK: precise(Object.values(colour.cmyk)) };
}

export function ConvertPage() {
  const { workspace, route, navigate, toast, copy, openColourEditor, saveColour, exportColour } = useWorkspace();
  const { status, scanning, scanColour, isNative, error: deviceError } = useDevice();
  const [hex, setHex] = useState(workspace.latest.hex);
  const [format, setFormat] = useState<ColourFormat>('HEX');
  const currentFormat = useRef(format); currentFormat.current = format;
  const [input, setInput] = useState(hex);
  const [error, setError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [origin, setOrigin] = useState<ColourOrigin | null>(null);
  const [scanPending, setScanPending] = useState(false);
  const [scanError, setScanError] = useState('');
  const scanVersion = useRef(0);
  const activeRoute = useRef(route); activeRoute.current = route;
  const mounted = useRef(true);
  const [scheme, setScheme] = useState('analogous');
  const [projectId, setProjectId] = useState('');
  const [saved, setSaved] = useState(false);
  const palette = withColourRenderContext({ hex }, 'ConvertPage.palette', () => generatePalette(hex, scheme));
  const colour = colorInfo(hex);

  useEffect(() => {
    if (route !== 'convert') {
      ++scanVersion.current; setScanPending(false);
      setLibraryOpen(false); setPickerOpen(false); setToolsOpen(false);
    }
  }, [route]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++scanVersion.current; }; }, []);

  useEffect(() => {
    if (projectId && !workspace.projects.some(project => project.id === projectId)) {
      setProjectId(''); setSaved(false);
    }
  }, [workspace.projects, projectId]);

  function cancelScanSelection() { ++scanVersion.current; setScanPending(false); setScanError(''); }
  function updateColour(value: string, source: ColourOrigin | null = null) {
    cancelScanSelection();
    setHex(value); setInput(inputValues(value)[currentFormat.current]); setOrigin(source); setError(''); setSaved(false);
  }
  function changeFormat(next: ColourFormat) {
    currentFormat.current = next; setFormat(next); setInput(inputValues(hex)[next]); setError('');
  }
  function changeInput(value: string) {
    // Incomplete edits remain visible; the last valid colour is never lost.
    cancelScanSelection(); setInput(value); setOrigin(null);
    try { setHex(parseConvertInput(value, format)); setError(''); setSaved(false); }
    catch (err) { setError(err instanceof Error ? err.message : 'Please check your colour value.'); }
  }
  function convert(event: FormEvent) {
    event.preventDefault();
    try { const value = parseConvertInput(input, format); updateColour(value, value === hex ? origin : null); toast('One colour, every format.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Please check your colour value.'); }
  }
  async function scanInput() {
    const version = ++scanVersion.current;
    setScanPending(true); setScanError('');
    try {
      const reading = await scanColour();
      if (!mounted.current || activeRoute.current !== 'convert' || version !== scanVersion.current) return;
      if (!reading) { setScanError('No colour was received. Check ChromaPod and try again.'); return; }
      updateColour(reading.hex, { kind: 'scan', source: reading.source, timestamp: reading.timestamp });
      toast('Scanned colour ready to convert.');
    } catch (reason) {
      if (mounted.current && activeRoute.current === 'convert' && version === scanVersion.current) setScanError(reason instanceof Error ? reason.message : 'The scan could not be completed.');
    } finally { if (mounted.current && version === scanVersion.current) setScanPending(false); }
  }
  function saveCurrentColour() {
    const capture = origin?.kind === 'scan' ? workspace.history.find(record => record.createdAt === origin.timestamp && record.hex === hex && record.source === origin.source) : undefined;
    const libraryColour = origin?.kind === 'library' ? workspace.library.find(record => record.id === origin.id && record.hex === hex) : undefined;
    openColourEditor(hex, libraryColour?.id, origin?.kind === 'scan' ? origin.source : libraryColour ? undefined : 'convert', capture?.id);
  }
  function savePalette() {
    let added = 0;
    for (const colour of [...new Set(palette)]) {
      if (workspace.library.some(item => item.hex === colour && (item.projectId || '') === projectId)) continue;
      saveColour({ hex: colour, tags: [scheme, 'palette'], projectId: projectId || undefined, source: 'palette' }); added++;
    }
    setSaved(true);
    toast(added ? `Saved ${added} palette colours${projectId ? ' to your project' : ' to your library'}.` : 'These palette colours are already saved.');
  }
  async function copyAll() {
    const colour = colorInfo(hex);
    const rounded = (values: number[], digits = 2) => values.map(value => Number(value.toFixed(digits))).join(', ');
    await copy(`HEX: ${colour.hex}\nRGB: ${rounded(Object.values(colour.rgb), 0)}\nHSL: ${rounded(Object.values(colour.hsl))}\nLAB: ${rounded(Object.values(colour.lab))}\nCMYK: ${rounded(Object.values(colour.cmyk))}`);
  }

  return <div className="wireframe-page wireframe-convert">
    <PageHeaderSlots actions={<button className="reference-header-button" type="button" aria-label="Colour actions" onClick={() => setToolsOpen(true)}><MoreHorizontal size={23} /></button>} />
    <h1 className="wireframe-title" tabIndex={-1}>Convert</h1>
    <h2 className="convert-page-title">Convert Colour</h2>
    <form id="convert-form" className="wireframe-convert-form" onSubmit={convert}>
      <div className="wireframe-convert-fields">
        <label className="wireframe-field-label" htmlFor="convert-format">Input format</label>
        <ThemedSelect id="convert-format" title="Input format" value={format} onChange={value => changeFormat(value as ColourFormat)} options={formats.map(value => ({ value, label: value }))} />
        <label className="wireframe-field-label" htmlFor="convert-input">{format} colour value</label>
        <div className="wireframe-output-field">
          <input id="convert-input" className="input" value={input} onChange={event => changeInput(event.target.value)} aria-label={`${format} colour value`} aria-invalid={Boolean(error)} aria-describedby="convert-hint convert-error" autoComplete="off" spellCheck={false} required />
          <button type="button" aria-label={`Copy ${format} value`} disabled={Boolean(error)} onClick={() => void copy(inputValues(hex)[format])}><Copy size={19} /></button>
        </div>
        <p id="convert-hint" className="helper">{hints[format]}</p>
        <p id="convert-error" className="error-message" role="alert">{error}</p>
      </div>
      <div className="convert-search-actions"><button className="btn primary wireframe-primary" type="submit">Convert</button></div>
    </form>
    <div className="convert-source-actions" role="group" aria-label="Choose colour source">
      <button className="btn secondary" type="button" data-action="convert-picker" onClick={() => { cancelScanSelection(); setPickerOpen(true); }}><Palette size={18} />Colour wheel</button>
      <button className="btn secondary" type="button" data-action="convert-scan" disabled={scanning || status.mode === 'disconnected'} onClick={() => void scanInput()}>{scanPending ? <LoaderCircle size={18} className="animate-spin" /> : <ScanLine size={18} />}{scanPending ? 'Waiting for scan' : 'Scan'}</button>
      <button className="btn secondary" type="button" data-action="convert-library" onClick={() => { cancelScanSelection(); setLibraryOpen(true); }}><Folder size={18} />Saved Library</button>
    </div>
    {scanPending && <p className="helper convert-scan-message" data-testid="convert-scan-status" role="status">{isNative && status.mode === 'bluetooth' ? 'Scan on ChromaPod to receive a new BLE colour.' : status.mode === 'demo' ? 'Capturing a simulated demo colour...' : 'Waiting for a new colour from ChromaPod...'}</p>}
    {status.mode === 'disconnected' && <p className="helper convert-scan-message"><a href="#device">Connect ChromaPod</a> or enable demo mode to scan.</p>}
    {scanError && <p className="error-message" role="alert">{deviceError || scanError}</p>}
    <section className="convert-colour-details" aria-labelledby="convert-colour-heading" aria-live="polite">
      <div className="convert-large-preview" style={{ background: hex }} role="img" aria-label={`${colour.name}, ${hex}`} />
      <div className="convert-colour-name"><h3 id="convert-colour-heading">{colour.name}</h3><strong>{hex}</strong></div>
      {origin && <p className="colour-result-source convert-origin" data-testid="convert-colour-source">{origin.kind === 'library' ? `Saved Library: ${origin.name}` : colourSourceLabel(origin.source)}</p>}
      <ColourMetrics hex={hex} formats={formats} />
      <div className="convert-result-actions"><button className="btn primary" onClick={saveCurrentColour}><Bookmark size={18} />Save to Library</button><button className="btn secondary" onClick={() => void exportColour(hex)}><Share2 size={18} />Share</button></div>
    </section>
    {pickerOpen && <Modal title="Choose a colour" onClose={() => setPickerOpen(false)}><ColourPicker value={hex} onChange={value => updateColour(value)} id="convert-picker" /><button className="btn primary full-width convert-picker-apply" onClick={() => setPickerOpen(false)}>Use colour</button></Modal>}
    {libraryOpen && <SavedLibraryPicker searchId="convert-library-search" onClose={() => setLibraryOpen(false)}
      onChoose={record => { updateColour(record.hex, { kind: 'library', id: record.id, name: record.name }); setLibraryOpen(false); }}
      onOpenLibrary={() => { setLibraryOpen(false); navigate('library'); }} />}
    {toolsOpen && <Modal title="Colour actions" onClose={() => setToolsOpen(false)}><div className="wireframe-tool-actions">
      <button className="btn secondary" onClick={() => { setToolsOpen(false); saveCurrentColour(); }}><Bookmark size={17} />Save to Library</button>
      <button className="btn secondary" onClick={() => void copyAll()}><Copy size={17} />Copy all values</button>
      <button className="btn secondary" onClick={() => void exportColour(hex)}><Share2 size={17} />Share / export colour</button>
      <button className="btn secondary" onClick={() => { updateColour(workspace.latest.hex); setToolsOpen(false); }}>Use latest capture</button>
      <details><summary>Colour harmonies</summary><label className="label" htmlFor="palette-scheme">Palette harmony</label><ThemedSelect id="palette-scheme" title="Palette harmony" value={scheme} onChange={value => { setScheme(value); setSaved(false); }} options={[{ value: 'analogous', label: 'Analogous' }, { value: 'complementary', label: 'Complementary' }, { value: 'monochromatic', label: 'Monochromatic' }, { value: 'triadic', label: 'Triadic' }, { value: 'split-complementary', label: 'Split complementary' }]} />
        <div className="wireframe-tool-palette">{palette.map((colour, index) => <button key={`${index}-${colour}`} style={{ background: colour }} aria-label={`Copy palette colour ${colour}`} onClick={() => void copy(colour)} />)}</div>
        <ProjectSelect value={projectId} onChange={value => { setProjectId(value); setSaved(false); }} label="Save palette to" /><button className="btn secondary" onClick={savePalette}><Palette size={17} />{saved ? 'Palette saved' : 'Save palette'}</button>
      </details>
    </div></Modal>}
  </div>;
}

export default ConvertPage;

