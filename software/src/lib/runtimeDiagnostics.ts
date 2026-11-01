import { recentColourDiagnostics } from './persistedColour';

/** Keep failures readable in both DevTools and Capacitor Logcat (Error objects may serialize as {}). */
export function runtimeErrorDetails(error: unknown, componentStack = ''): string {
  let name = 'Error', message = 'Unknown runtime failure', stack = '';
  try {
    if (error && typeof error === 'object') {
      const detail = error as { name?: unknown; message?: unknown; stack?: unknown };
      if (typeof detail.name === 'string') name = detail.name;
      if (typeof detail.message === 'string') message = detail.message;
      if (typeof detail.stack === 'string') stack = detail.stack;
    } else message = String(error);
  } catch { /* Even a faulty error object must not break the fallback view. */ }
  return [`${name}: ${message}`, stack, componentStack && `Component stack:${componentStack}`].filter(Boolean).join('\n');
}

export function reportRuntimeError(error: unknown, componentStack = ''): string {
  const colourContext = recentColourDiagnostics();
  const details = runtimeErrorDetails(error, componentStack) + (colourContext.length ? `\nRecent saved-colour recovery context: ${JSON.stringify(colourContext)}` : '');
  // Do not read, clear, or overwrite workspace storage to report a render failure.
  console.error(`[CHROMA runtime] ${details}`);
  return details;
}

/** Identify the precise render input if a colour calculation ever fails again. */
export function withColourRenderContext<T>(colour: { id?: string; name?: string; hex: string }, context: string, render: () => T): T {
  try { return render(); }
  catch (error) {
    const safeLabel = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : undefined;
    const diagnostic = { context: safeLabel(context), id: safeLabel(colour.id), name: safeLabel(colour.name), hex: /^#[0-9a-f]{6}$/i.test(colour.hex) ? colour.hex : 'invalid HEX' };
    console.error(`[CHROMA colour render] ${JSON.stringify(diagnostic)}\n${runtimeErrorDetails(error)}`);
    throw error;
  }
}
