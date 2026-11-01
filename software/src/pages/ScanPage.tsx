import { ChevronRight, ScanLine } from 'lucide-react';
import { useDevice } from '../state/DeviceContext';
import { useWorkspace } from '../state/WorkspaceContext';
import { ColourResult, colourSourceLabel } from '../components/ColourResult';
import { PageHeaderSlots } from '../components/PageHeaderSlots';
import { colorInfo } from '../lib/color';
import { exportLibraryFile } from '../services/libraryExport';
import type { ColourRecord } from '../types';
import './scan-compare-wireframe.css';

const captureSources = new Set(['bluetooth', 'usb', 'wifi', 'demo', 'captured', 'device', 'scan']);
export default function ScanPage() {
  const { status, scanning, scanColour, error } = useDevice();
  const { workspace, openColourEditor, navigate, toast, view, goBack } = useWorkspace();
  const captures = workspace.history.filter(item => captureSources.has(item.source));
  const latest = captureSources.has(workspace.latest.source) ? workspace.latest : captures[0];
  const selected = captures.find(item => view === 'reading/' + encodeURIComponent(item.id)) || latest;
  async function shareReading(record: ColourRecord) {
    try {
      const contents = JSON.stringify({ product: 'CHROMA', version: 2, exportedAt: new Date().toISOString(), colours: [{ ...record, formats: colorInfo(record.hex) }], comparisons: [], projects: workspace.projects.filter(project => project.id === record.projectId) }, null, 2);
      toast(await exportLibraryFile(contents, 'colour'));
    } catch (reason) { toast(reason instanceof Error ? reason.message : 'This scan could not be shared.'); }
  }
  async function scan() {
    if (view) navigate('scan');
    try { await scanColour(); } catch (reason) { toast(reason instanceof Error ? reason.message : 'The scan could not be completed.'); }
  }
  return <div className="wireframe-page wireframe-scan chromapod-scan">
    {view.startsWith('reading/') && <PageHeaderSlots onBack={() => goBack('scan')} backLabel="Back to latest scan" />}
    <div className="tool-section-heading"><h2>{selected ? 'Scan Result' : 'Recent scans'}</h2>{selected && <span>{selected.id === latest?.id ? 'Latest capture' : 'Previous capture'}</span>}</div>
    {selected ? <ColourResult header={false} title="Scan Result" sample={selected.hex} source={selected.source} onSave={() => openColourEditor(selected.hex, undefined, selected.source, selected.id)} onShare={() => void shareReading(selected)} onScan={() => void scan()} scanning={scanning} scanDisabled={status.mode === 'disconnected'} details={<dl><div><dt>Captured</dt><dd><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleString()}</time></dd></div><div><dt>Source</dt><dd>{colourSourceLabel(selected.source)}</dd></div>{selected.clear !== undefined && <div><dt>Clear channel</dt><dd>{selected.clear}</dd></div>}<div><dt>Reading ID</dt><dd>{selected.id}</dd></div>{selected.projectId && <div><dt>Project</dt><dd>{workspace.projects.find(project => project.id === selected.projectId)?.name || selected.projectId}</dd></div>}{selected.tags.length > 0 && <div><dt>Tags</dt><dd>{selected.tags.join(', ')}</dd></div>}</dl>} /> : <><h1 className="sr-only" tabIndex={-1}>Scan</h1><section className="capture-empty" aria-label="No captured colour"><ScanLine size={34} /><h3>No scans yet</h3><p>Your captured colours will appear here. Sample colours stay in the Library.</p><button className="btn primary" type="button" data-action="scan" disabled={scanning || status.mode === 'disconnected'} onClick={() => void scan()}>{scanning ? 'Waiting for scan...' : 'Scan a colour'}</button></section></>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {status.mode === 'disconnected' && <p className="capture-connection">Connect ChromaPod or choose demo mode in <button className="text-button" type="button" onClick={() => navigate('device')}>Device</button>.</p>}
    {captures.length > 0 && <section className="capture-history" aria-label="Recent scans"><div className="tool-section-heading"><h2>Recent scans</h2><span>{captures.length} captures</span></div>{captures.slice(0, 8).map(record => <button key={record.id} type="button" onClick={() => { navigate('scan', 'reading/' + encodeURIComponent(record.id)); }} aria-label={'View captured colour ' + record.name + ', ' + record.hex}><i style={{ background: record.hex }} /><span><strong>{record.name}</strong><small>{record.hex} - {colourSourceLabel(record.source)}</small></span><ChevronRight size={17} /></button>)}</section>}
  </div>;
}
