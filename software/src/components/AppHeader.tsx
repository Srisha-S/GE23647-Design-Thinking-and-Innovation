import { ChevronLeft, Menu, MoreHorizontal, Settings } from 'lucide-react';
import { useDevice } from '../state/DeviceContext';
import { useWorkspace } from '../state/WorkspaceContext';
import { StudioBrand } from './StudioBrand';
import { routeTitle } from './HamburgerDrawer';

export function AppHeader({ menuOpen, onOpenMenu }: { menuOpen: boolean; onOpenMenu: () => void }) {
  const { status } = useDevice();
  const { navigate, route, goBack } = useWorkspace();
  const label = status.mode === 'demo' ? 'Demo mode' : status.connected ? 'Connected' : 'Disconnected';
  const home = route === 'home';
  return <header className={`studio-header reference-header ${home ? 'reference-header-home' : ''}`}><div className="studio-header-inner">
    {home ? <div className="reference-home-brand"><button className="studio-menu-button" type="button" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="navigation-drawer" onClick={onOpenMenu}><Menu size={20} /></button><a className="studio-brand-link" href="#home" aria-label="CHROMA Studio Home"><StudioBrand /></a></div> : <><div id="page-header-back" className="wireframe-header-slot"><button className="reference-header-button reference-back wireframe-header-default" type="button" aria-label="Back" onClick={() => goBack()}><ChevronLeft size={26} /></button></div><div id="page-header-title" className="reference-page-title wireframe-header-slot"><span className="wireframe-header-default">{['scan', 'compare', 'image', 'convert'].includes(route) ? 'ChromaPod' : routeTitle(route)}</span></div></>}
    <div id="page-header-actions" className="wireframe-header-slot">{home ? <button className="reference-header-button reference-header-action" type="button" aria-label="Open Settings" onClick={() => navigate('settings')}><Settings size={22} /></button> : ['device', 'about', 'visualize'].includes(route) ? <button className="reference-header-button reference-header-action wireframe-header-default" type="button" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="navigation-drawer" onClick={onOpenMenu}><MoreHorizontal size={23} /></button> : null}</div>
    <span id="device-status" className="sr-only">{label}</span>
  </div></header>;
}
