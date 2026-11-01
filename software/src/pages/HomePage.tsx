import { ChevronRight, Copy } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import { useDevice } from '../state/DeviceContext';
import { ChromaPodArtwork, FeatureArtwork, type FeatureKind } from '../components/FeatureArtwork';

const actions: { route: FeatureKind; title: string }[] = [
  { route: 'scan', title: 'Scan' }, { route: 'compare', title: 'Compare' },
  { route: 'image', title: 'Image Match' }, { route: 'convert', title: 'Convert' },
];

export default function HomePage() {
  const { workspace, navigate, openColourDetail, copy } = useWorkspace();
  const { status } = useDevice();
  const latest = workspace.latest;
  const deviceLabel = status.mode === 'demo' ? 'Demo mode' : status.connected ? 'Connected' : 'Disconnected';
  return <div className="wireframe-page wireframe-home">
    <h1 className="sr-only">CHROMA Studio</h1>
    <button data-testid="reference-device-card" className="wireframe-home-device" onClick={() => navigate('device')} aria-label={`ChromaPod: ${deviceLabel}. Manage device`}>
      <ChromaPodArtwork /><span><strong>ChromaPod</strong><small><i className={`status-dot ${status.connected && status.mode !== 'demo' ? '' : 'offline'}`} />{deviceLabel}</small></span><ChevronRight size={20} />
    </button>
    <section className="wireframe-last-scan" aria-labelledby="last-scan-title">
      <h2 id="last-scan-title">Last Scanned Colour</h2>
      <div className="wireframe-home-reading"><button className="wireframe-home-reading-open" onClick={() => navigate('scan')} aria-label={`Open latest scan ${latest.hex}`}><span className="wireframe-home-swatch" style={{ background: latest.hex }} /><span><strong>{latest.hex}</strong><small>RGB {latest.rgb.r}, {latest.rgb.g}, {latest.rgb.b}</small><small className="wireframe-source">{latest.source === 'demo' ? 'Demo scan' : latest.source === 'sample' ? 'Sample colour' : latest.source === 'bluetooth' ? 'BLE scan' : 'Captured colour'}</small></span></button><button className="icon-button" aria-label="Copy latest HEX" onClick={() => void copy(latest.hex)}><Copy size={17} /></button></div>
    </section>
    <section className="wireframe-saved-colours" aria-labelledby="home-saved-title"><div className="wireframe-section-heading"><h2 id="home-saved-title">Saved Colours</h2><button className="text-button" onClick={() => navigate('library')}>See all <ChevronRight size={15} /></button></div><div className="wireframe-home-saved">{workspace.library.slice(0, 6).map(colour => <button key={colour.id} aria-label={`View ${colour.name}`} style={{ background: colour.hex }} onClick={() => openColourDetail(colour.hex, colour.id)} />)}{!workspace.library.length && <p className="helper">Save your first colour from Scan.</p>}</div></section>
    <section className="wireframe-quick-actions" aria-labelledby="quick-actions-title"><h2 id="quick-actions-title">Quick Actions</h2><div>{actions.map(({ route, title }) => <button key={route} data-feature={route} className={`wireframe-quick-action feature-${route}`} onClick={() => navigate(route)}><FeatureArtwork kind={route} /><strong>{title}</strong></button>)}</div></section>
  </div>;
}
