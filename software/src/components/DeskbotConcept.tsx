import { Camera, CircleDot, FolderOpen, MessageCircle, Monitor, Palette, ScanLine } from 'lucide-react';
import '../pages/device.css';

export function DeskbotConcept() {
  return (
    <section className="deskbot-concept" aria-labelledby="deskbot-heading">
      <div className="deskbot-copy">
        <span className="future-badge">Future concept</span>
        <h2 id="deskbot-heading">Meet CHROMA DESKBOT.</h2>
        <p>A colour-aware companion for the designer’s desk. A future exploration of how colour memory, context and conversation could fit into your creative process.</p>
        <ul className="deskbot-features" aria-label="Proposed future capabilities">
          <li><ScanLine size={14} />Colour sensor</li><li><Camera size={14} />Camera</li>
          <li><Monitor size={14} />Display</li><li><MessageCircle size={14} />Voice interaction</li>
          <li><CircleDot size={14} />Colour memory</li><li><FolderOpen size={14} />Project context</li>
          <li><Palette size={14} />Colour recommendations</li>
        </ul>
        <p className="deskbot-disclaimer">A concept for the future. These capabilities are not part of the current CHROMA prototype.</p>
      </div>
      <div className="deskbot-illustration" role="img" aria-label="Concept illustration of a small CHROMA desk companion with a tilted display, camera and colour sensor">
        <div className="deskbot-halo" />
        <div className="deskbot-body">
          <span className="deskbot-camera" />
          <div className="deskbot-display"><span>HELLO, COLOUR.</span><div><i /><i /><i /></div><small>A little inspiration.</small></div>
          <span className="deskbot-wordmark">C H R O M A</span>
          <span className="deskbot-sensor" />
        </div>
        <div className="deskbot-neck" /><div className="deskbot-foot" />
        <span className="deskbot-caption">An idea taking shape.</span>
      </div>
    </section>
  );
}

export default DeskbotConcept;
