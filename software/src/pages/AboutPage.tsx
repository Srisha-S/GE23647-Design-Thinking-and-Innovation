import { ArrowUpRight, Info } from 'lucide-react';
import { PageHeading } from '../components/ui';
import { useWorkspace } from '../state/WorkspaceContext';
import './collections-studio.css';

export default function AboutPage() {
  const { navigate } = useWorkspace();

  return <div className="studio-settings">
    <PageHeading eyebrow="CHROMA Studio" title="About" description="Turn colours into possibilities." />
    <div className="studio-settings-content">
      <section className="panel"><div className="studio-settings-section-title"><Info size={21} /><h2>Turn colours into possibilities.</h2></div><p>CHROMA Studio brings real-world colour capture, comparison, conversion and image matching into one workspace.</p><p>Pair your CHROMAPOD from Device, or explore with clearly labelled demo readings.</p><button className="btn secondary" onClick={() => navigate('device')}>Open Device <ArrowUpRight size={15} /></button></section>
      <section className="panel"><h2>About colour results</h2><p>Colour names are approximate. LAB uses D65, and CMYK is an unprofiled approximation. Image Match uses CIEDE2000; BLE Compare retains the device-provided Delta E.</p><p>Material and print accuracy depends on lighting, profiles and calibration. The guided calibration screen is a UI preview and does not calibrate the physical sensor.</p></section>
    </div>
  </div>;
}
