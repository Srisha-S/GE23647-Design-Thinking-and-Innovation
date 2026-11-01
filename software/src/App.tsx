import { useEffect, useRef, useState } from 'react';
import { useDevice } from './state/DeviceContext';
import { useWorkspace } from './state/WorkspaceContext';
import { WorkspaceDialogs } from './components/WorkspaceDialogs';
import HomePage from './pages/HomePage';
import ScanPage from './pages/ScanPage';
import ComparePage from './pages/ComparePage';
import ConvertPage from './pages/ConvertPage';
import ImagePage from './pages/ImagePage';
import LibraryPage from './pages/LibraryPage';
import ProjectsPage from './pages/ProjectsPage';
import DevicePage from './pages/DevicePage';
import type { Route } from './types';
import SettingsPage from './pages/SettingsPage';
import AboutPage from './pages/AboutPage';
import VisualizePage from './features/visualize/VisualizePage';
import { AppHeader } from './components/AppHeader';
import { HamburgerDrawer, routeTitle } from './components/HamburgerDrawer';
import { BottomNavigation } from './components/BottomNavigation';
import { PageContainer } from './components/PageContainer';
import { ChromaPodTabs } from './components/ChromaPodTabs';

export default function App() {
  const { route, view, toastMessage, goBack, canGoBack } = useWorkspace();
  const { setActiveMode } = useDevice();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [visited, setVisited] = useState<Set<Route>>(() => new Set([route]));
  const firstRender = useRef(true);
  useEffect(() => {
    const target = window as Window & { chromaHandleBack?: () => boolean };
    target.chromaHandleBack = () => {
      if (!canGoBack && !document.querySelector('dialog[open]')) return false;
      goBack(); return true;
    };
    return () => { delete target.chromaHandleBack; };
  }, [goBack, canGoBack]);
  useEffect(() => {
    setMobileMenu(false); setVisited(previous => new Set([...previous, route]));
    document.title = `${routeTitle(route)} - CHROMA Studio`;
    if (['scan', 'compare', 'convert', 'image'].includes(route)) void setActiveMode(route === 'image' ? 'image-match' : route);
    if (!firstRender.current) requestAnimationFrame(() => { const heading = document.querySelector<HTMLElement>(`[data-page="${route}"] h1`); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } });
    firstRender.current = false;
  }, [route, view, setActiveMode]);
  const page = route === 'home' ? <HomePage /> : route === 'scan' ? <ScanPage /> : route === 'compare' ? <ComparePage /> : route === 'image' ? <ImagePage /> : route === 'library' ? <LibraryPage /> : route === 'projects' ? <ProjectsPage /> : route === 'device' ? <DevicePage /> : route === 'settings' ? <SettingsPage /> : route === 'about' ? <AboutPage /> : null;
  return <><a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to workspace</a><AppHeader menuOpen={mobileMenu} onOpenMenu={() => setMobileMenu(true)} /><HamburgerDrawer open={mobileMenu} onClose={() => setMobileMenu(false)} route={route} />
    <main id="main" tabIndex={-1}><ChromaPodTabs />{page && <PageContainer key={route} route={route}>{page}</PageContainer>}{(visited.has('convert') || route === 'convert') && <PageContainer route="convert" hidden={route !== 'convert'}><ConvertPage /></PageContainer>}{(visited.has('visualize') || route === 'visualize') && <PageContainer route="visualize" hidden={route !== 'visualize'}><VisualizePage active={route === 'visualize'} /></PageContainer>}</main>
    <BottomNavigation route={route} /><WorkspaceDialogs /><div className={`toast ${toastMessage ? 'visible' : ''}`} role="status" aria-live="polite">{toastMessage}</div>
  </>;
}
