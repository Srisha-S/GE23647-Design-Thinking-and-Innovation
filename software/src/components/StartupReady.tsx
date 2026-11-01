import { useEffect, type ReactNode } from 'react';

/** The HTML launch covers asset loading; animate only after React commits. */
export function StartupReady({ children }: { children: ReactNode }) {
  useEffect(() => {
    const launch = document.getElementById('chroma-launch');
    if (!launch) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const image = launch.querySelector('img');
    const ready = image?.decode().catch(() => undefined) || Promise.resolve();
    void ready.then(() => {
      if (cancelled) return;
      // Start motion after Android's system splash yields to the WebView.
      const native = (window as Window & { ChromaStartupBridge?: { ready: () => void } }).ChromaStartupBridge;
      native?.ready();
      const finish = () => {
        if (cancelled) return;
        launch.remove();
        document.body.classList.remove('chroma-starting');
        const root = document.getElementById('root');
        root?.removeAttribute('inert');
        root?.removeAttribute('aria-busy');
      };
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const hold = 1560;
      const fade = 240;
      launch.style.setProperty('--launch-hold', `${hold}ms`);
      launch.style.setProperty('--launch-fade', `${fade}ms`);
      frame = requestAnimationFrame(() => {
        if (!cancelled) launch.classList.add('chroma-launch-running');
      });
      // Timed dismissal also works if animation events are disabled or never fire.
      timer = setTimeout(finish, reducedMotion ? 180 : hold + fade);
    });
    return () => { cancelled = true; clearTimeout(timer); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  return children;
}
