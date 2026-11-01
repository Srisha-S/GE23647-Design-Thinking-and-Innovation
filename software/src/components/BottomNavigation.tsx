import { Folder, Home, NotebookText, ScanLine } from 'lucide-react';
import type { Route } from '../types';

const tabs = [
  { route: 'home', label: 'Home', icon: Home, pages: ['home'] },
  { route: 'scan', label: 'Scan', icon: ScanLine, pages: ['scan', 'compare', 'convert', 'image'] },
  { route: 'library', label: 'Library', icon: Folder, pages: ['library'] },
  { route: 'projects', label: 'Projects', icon: NotebookText, pages: ['projects'] },
];
export function BottomNavigation({ route }: { route: Route }) {
  return <nav className="studio-bottom-nav reference-bottom-nav" aria-label="Primary navigation"><div>{tabs.map(({ route: destination, label, icon: Icon, pages }) => <a key={destination} href={`#${destination}`} data-bottom-nav={destination} className={pages.includes(route) ? 'active' : ''} aria-label={label} aria-current={pages.includes(route) ? 'page' : undefined}><span className="reference-nav-icon"><Icon size={24} strokeWidth={2.3} fill={destination === 'home' ? 'currentColor' : 'none'} /></span><span className="reference-nav-label">{label}</span></a>)}</div></nav>;
}
