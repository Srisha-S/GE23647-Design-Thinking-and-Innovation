import { Bookmark, ScanLine, Share2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { colorInfo, deltaE } from '../lib/color';
import { indicativeMatchPercent } from '../lib/matchPresentation';
import { PageHeaderSlots } from './PageHeaderSlots';
import { ColourMetrics } from './ui';
import './colour-tools.css';

export function colourSourceLabel(source?: string): string {
  return source === 'demo' ? 'Demo scan - simulated' : source === 'bluetooth' ? 'BLE capture - ChromaPod' : source === 'usb' ? 'USB capture - ChromaPod' : source === 'wifi' ? 'Wi-Fi capture - ChromaPod' : source === 'library' ? 'Saved Library colour' : source === 'image' ? 'Image colour' : source === 'convert' ? 'Converted colour' : source === 'sample' ? 'Sample colour' : ['captured', 'device', 'scan'].includes(source || '') ? 'ChromaPod capture' : 'Digital colour';
}
export function ComparisonDial({ a, b, difference, waiting = false }: { a: string; b: string; difference: number; waiting?: boolean }) {
  const percent = indicativeMatchPercent(difference);
  return <div className="colour-comparison-dial" data-testid="compare-match-ring" data-match-percent={waiting ? undefined : percent} aria-label={waiting ? 'Waiting for comparison sample' : 'Indicative match ' + percent + ' percent'}>
    <div className="colour-comparison-halves" aria-hidden="true"><i style={{ background: a }} /><i style={{ background: b }} /></div>
    <div className="colour-comparison-score"><span>{waiting ? 'Waiting for scan' : 'Match score'}</span><strong>{waiting ? '-' : percent + '%'}</strong><small>{waiting ? 'Scan the sample' : difference < 1 ? 'Match' : difference < 3 ? 'Very close' : difference < 10 ? 'Similar colours' : 'Different colours'}</small></div>
  </div>;
}
export function DifferenceRange({ difference, waiting = false, device = false }: { difference: number; waiting?: boolean; device?: boolean }) {
  return <section className="colour-difference-range" aria-label="Delta E range"><div className="colour-difference-title"><h2>Colour difference</h2>{!waiting && <span>{'\u0394'}E <strong data-testid="delta-e">{difference.toFixed(2)}</strong></span>}</div><div className="colour-difference-bar" role="meter" aria-label="Delta E difference" aria-valuemin={0} aria-valuemax={20} aria-valuenow={waiting ? 0 : Math.min(20, difference)} aria-valuetext={waiting ? 'Waiting for sample' : 'Delta E ' + difference.toFixed(2)}><i style={{ left: Math.min(100, Math.max(0, difference / 20 * 100)) + '%' }} /></div><div className="colour-difference-labels"><span>Close: 0-3</span><span>Different: 10+</span></div>{device && <p className="colour-result-method">Device-provided Delta E - CHROMA BLE</p>}</section>;
}
export interface ColourResultProps {
  title: string; sample: string; reference?: string; source?: string; referenceSource?: string; deviceDeltaE?: number; waiting?: boolean;
  onBack?: () => void; backLabel?: string; header?: boolean; onSave?: () => void; onShare?: () => void; onScan?: () => void; scanning?: boolean; scanDisabled?: boolean; saved?: boolean; details?: ReactNode;
}
export function ColourResult({ title, sample, reference, source, referenceSource, deviceDeltaE, waiting = false, onBack, backLabel = 'Back', header = true, onSave, onShare, onScan, scanning, scanDisabled, saved, details }: ColourResultProps) {
  const info = colorInfo(sample);
  const difference = reference ? deviceDeltaE ?? deltaE(reference, sample) : 0;
  return <div className="colour-result" data-testid="colour-result">
    {header && <PageHeaderSlots title={title} onBack={onBack} backLabel={backLabel} />}
    <h1 className="sr-only" tabIndex={-1}>{title}</h1>
    {reference ? <><ComparisonDial a={reference} b={waiting ? 'var(--surface-soft)' : sample} difference={difference} waiting={waiting} /><DifferenceRange difference={difference} waiting={waiting} device={deviceDeltaE !== undefined} /></> : <div className="colour-result-swatch" style={{ background: sample }} role="img" aria-label={info.name + ', ' + sample} />}
    {waiting && <p className="wireframe-compare-waiting" role="status">Reference saved. Waiting for a comparison sample from ChromaPod.</p>}
    <div className={reference ? 'colour-result-formats paired' : 'colour-result-formats'}>
      {reference && <section aria-label="Reference colour values"><h2>Reference <strong>{reference}</strong></h2><p className="colour-result-source">{colourSourceLabel(referenceSource)}</p><ColourMetrics hex={reference} formats={['HEX', 'RGB', 'HSL', 'CMYK', 'LAB']} /></section>}
      <section aria-label="Sample colour values"><h2>{reference ? 'Sample' : info.name}<strong>{waiting ? 'Waiting for scan' : sample}</strong></h2>{!waiting && <><p className="colour-result-source">{colourSourceLabel(source)}</p><ColourMetrics hex={sample} formats={['HEX', 'RGB', 'HSL', 'CMYK', 'LAB']} /></>}</section>
    </div>
    {details && <div className="colour-result-details">{details}</div>}
    <div className="colour-result-actions">{onSave && <button className="btn primary" type="button" disabled={waiting || saved} onClick={onSave}><Bookmark size={17} />{saved ? 'Saved' : 'Save'}</button>}{onShare && <button className="btn secondary" type="button" disabled={waiting} onClick={onShare}><Share2 size={17} />Share</button>}{onScan && <button className="btn secondary colour-result-rescan" type="button" data-action="scan" disabled={scanning || scanDisabled} onClick={onScan}><ScanLine size={17} />{scanning ? 'Waiting for scan...' : 'Scan Again'}</button>}</div>
    {reference && <p className="colour-result-method">{deviceDeltaE !== undefined ? 'Device-provided Delta E; values calculated in the app.' : 'CIEDE2000 - sRGB / D65. Score is indicative on a 0-20 Delta E scale.'}</p>}
  </div>;
}
