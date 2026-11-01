import { useEffect, useRef, type KeyboardEvent } from 'react';
import { GitCompareArrows, SlidersHorizontal, ChevronRight, Folder, Home, Image, Info, NotebookText, Paintbrush, Settings, ScanLine, X } from 'lucide-react';
import { useDevice } from '../state/DeviceContext';
import { StudioBrand } from './StudioBrand';
import { ChromaPodArtwork } from './FeatureArtwork';
import type { Route } from '../types';
import { openModal } from '../lib/dialogs';

export const destinations = [
  { route: 'home', title: 'Home', icon: Home },
  { route: 'scan', title: 'Scan', icon: ScanLine },
  { route: 'compare', title: 'Compare', icon: GitCompareArrows },
  { route: 'convert', title: 'Convert', icon: SlidersHorizontal },
  { route: 'image', title: 'Image Match', icon: Image },
  { route: 'visualize', title: 'Visualize', icon: Paintbrush },
  { route: 'library', title: 'Library', icon: Folder },
  { route: 'projects', title: 'Projects', icon: NotebookText },
  { route: 'settings', title: 'Settings', icon: Settings },
  { route: 'about', title: 'About', icon: Info },
] satisfies { route: Route; title: string; icon: typeof Home }[];

export function routeTitle(route: Route): string {
  return route === 'scan' ? 'Scan Result' : route === 'device' ? 'ChromaPod' : destinations.find(item => item.route === route)?.title || 'CHROMA Studio';
}

export function HamburgerDrawer({ open, onClose, route }: { open: boolean; onClose: () => void; route: Route }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { status } = useDevice();
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current!;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    openModal(dialog);
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]'));
    const first = elements[0], last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <dialog id="navigation-drawer" ref={dialogRef} className="studio-drawer" aria-label="CHROMA Studio navigation" onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <div className="studio-drawer-heading"><StudioBrand /><button className="icon-button" type="button" aria-label="Close navigation" onClick={onClose} autoFocus><X size={22} /></button></div>
    <nav id="main-navigation" className={`main-nav studio-drawer-nav ${open ? 'mobile-open' : ''}`} aria-label="Main navigation">
      {destinations.filter(item => !['settings', 'about'].includes(item.route)).map(({ route: destination, title, icon: Icon }) => <a key={destination} href={`#${destination}`} data-nav={destination} className={route === destination ? 'active' : ''} aria-current={route === destination ? 'page' : undefined} onClick={onClose}><Icon size={20} /><span>{title}</span></a>)}
    </nav>
    <nav className="studio-drawer-nav chroma-menu-bottom" aria-label="Device and information">
      <a className="wireframe-menu-device" href="#device" data-nav="device" onClick={onClose}><ChromaPodArtwork /><span><strong>ChromaPod</strong><small><i className={`status-dot ${status.connected && status.mode !== 'demo' ? '' : 'offline'}`} />{status.mode === 'demo' ? 'Demo mode' : status.connected ? 'Connected' : 'Disconnected'}</small></span><ChevronRight size={17} /></a>
      <a href="#about" data-nav="about" className={route === 'about' ? 'active' : ''} onClick={onClose}><Info size={20} /><span>About</span></a>
    </nav>
  </dialog>;
}
