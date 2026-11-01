import { ArrowRight, ScanLine } from 'lucide-react';
import { useDevice } from '../state/DeviceContext';
import '../pages/device.css';

export function OledPreview({ compact = false }: { compact?: boolean }) {
  const { reading, status, scanning, scanColour, setActiveMode } = useDevice();
  const ready = status.mode !== 'disconnected';
  const demonstrate = async () => {
    await setActiveMode('scan');
    await scanColour();
  };

  return (
    <section className={`oled-section ${compact ? 'oled-compact' : ''}`} aria-label="CHROMA OLED preview">
      <div className="oled-copy">
        <span className="eyebrow">A shared colour language</span>
        <h2>Small screen. Same colour.</h2>
        <p>The reading on CHROMA becomes a colour you can use in your workspace.</p>
        <div className="oled-steps" aria-hidden="true">
          <span>Ready</span><ArrowRight size={13} /><span>Scan</span><ArrowRight size={13} /><span>Understand</span>
        </div>
        <button className="btn secondary small" onClick={() => void demonstrate()} disabled={!ready || scanning}>
          <ScanLine size={15} />{scanning ? 'Scanning…' : status.mode === 'demo' ? 'Try OLED demo' : 'Scan from CHROMA'}
        </button>
        {!ready && <p className="helper">Enable demo mode or connect a device to try it.</p>}
      </div>
      <div className="oled-bezel">
        <div className={`oled-screen ${scanning ? 'is-scanning' : ''}`} role="status" aria-live="polite">
          <div className="oled-top"><span>CHROMA</span><span className="oled-battery" aria-label={status.battery === null ? 'Battery level unknown' : `${status.battery}% battery`} /></div>
          <div className="oled-content">
            {scanning ? <><div className="oled-crosshair"><i /></div><strong>SCANNING…</strong><small>Reading the surface</small></> : ready && reading ? <>
              <div className="oled-result-chip" style={{ backgroundColor: reading.hex }} />
              <strong>{reading.hex}</strong><small>{reading.name?.toUpperCase() || 'COLOUR CAPTURED'}</small>
            </> : <><div className="oled-crosshair" /><strong>{ready ? 'READY' : 'OFFLINE'}</strong><small>{ready ? 'PRESS SCAN TO BEGIN' : 'CONNECT TO BEGIN'}</small></>}
          </div>
          <div className="oled-bottom"><span>{status.mode === 'demo' ? 'SIMULATED PREVIEW' : 'DEVICE PREVIEW'}</span><span>{scanning ? '●' : '○'}</span></div>
        </div>
      </div>
    </section>
  );
}

export default OledPreview;
