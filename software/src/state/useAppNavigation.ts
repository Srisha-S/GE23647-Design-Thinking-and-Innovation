import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from '../types';
import { topmostDialog } from '../lib/dialogs';

const routes: Route[] = ['home', 'scan', 'compare', 'convert', 'image', 'library', 'projects', 'device', 'settings', 'about', 'visualize'];
export function routeFromHash(): Route {
  const hash = location.hash.slice(1).split('/')[0];
  if (hash === 'dashboard') return 'home';
  if (hash === 'image-match') return 'image';
  return routes.includes(hash as Route) ? hash as Route : 'home';
}
function currentView() { return location.hash.slice(1).split('/').slice(1).join('/'); }
const parents: Partial<Record<Route, Route>> = { device: 'settings', settings: 'home', about: 'home', scan: 'home', compare: 'scan', image: 'scan', convert: 'scan', visualize: 'library', library: 'home', projects: 'home' };

/** Real browser history records both routes and their result/folder/detail steps. */
export function useAppNavigation(onChange: (from: Route, to: Route) => void) {
  const [frame, setFrame] = useState(() => ({ route: routeFromHash(), view: currentView(), index: 0 }));
  const active = useRef(frame);
  const listener = useRef(onChange); listener.current = onChange;
  const trail = useRef({ session: crypto.randomUUID?.() || String(Date.now()), hashes: [location.hash], index: 0 });
  const apply = useCallback(() => {
    const next = { route: routeFromHash(), view: currentView(), index: trail.current.index };
    listener.current(active.current.route, next.route);
    active.current = next; setFrame(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  useEffect(() => {
    const state = trail.current;
    history.replaceState({ ...history.state, chromaNavigation: { session: state.session, index: 0 } }, '', location.href);
    const change = () => {
      const mark = history.state?.chromaNavigation;
      if (mark?.session === state.session && Number.isInteger(mark.index)) state.index = mark.index;
      else {
        state.hashes = state.hashes.slice(0, state.index + 1);
        state.hashes.push(location.hash); state.index++;
        history.replaceState({ ...history.state, chromaNavigation: { session: state.session, index: state.index } }, '', location.href);
      }
      apply();
    };
    window.addEventListener('hashchange', change);
    window.addEventListener('popstate', change);
    return () => { window.removeEventListener('hashchange', change); window.removeEventListener('popstate', change); };
  }, [apply]);
  const navigate = useCallback((route: Route, view = '', replace = false) => {
    const hash = '#' + route + (view ? '/' + view : '');
    if (hash !== location.hash) {
      const state = trail.current;
      if (replace) {
        state.hashes[state.index] = hash;
        history.replaceState({ ...history.state, chromaNavigation: { session: state.session, index: state.index } }, '', hash);
      } else {
        state.hashes = state.hashes.slice(0, state.index + 1); state.hashes.push(hash); state.index++;
        history.pushState({ ...history.state, chromaNavigation: { session: state.session, index: state.index } }, '', hash);
      }
    }
    apply();
  }, [apply]);
  const goBack = useCallback((fallback?: Route, fallbackView = '') => {
    const dialog = topmostDialog();
    if (dialog) {
      const event = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(event);
      if (!event.defaultPrevented && dialog.open) dialog.close();
      return;
    }
    if (trail.current.index > 0) history.back();
    else {
      // A cold deep link has no in-app predecessor. Replace it with its parent
      // instead of pushing a parent that would lead straight back to the child.
      const route = fallback || (active.current.view ? active.current.route : parents[active.current.route]) || 'home';
      const state = trail.current;
      const hash = '#' + route + (fallback && fallbackView ? '/' + fallbackView : '');
      state.hashes = [hash];
      history.replaceState({ ...history.state, chromaNavigation: { session: state.session, index: 0 } }, '', hash);
      apply();
    }
  }, [apply]);
  return { route: frame.route, view: frame.view, navigate, goBack, canGoBack: frame.index > 0 || frame.route !== 'home' || !!frame.view };
}
