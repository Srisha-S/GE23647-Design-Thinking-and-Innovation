import { useWorkspace } from '../state/WorkspaceContext';
import type { Route } from '../types';

const tools: { route: Route; label: string }[] = [
  { route: 'scan', label: 'Scan' },
  { route: 'compare', label: 'Compare' },
  { route: 'image', label: 'Image Match' },
  { route: 'convert', label: 'Convert' },
];
export function ChromaPodTabs() {
  const { route, view, navigate } = useWorkspace();
  if (!tools.some(tool => tool.route === route) || view === 'result') return null;
  return <nav className="chroma-tool-tabs" aria-label="ChromaPod tools">{tools.map(tool => <button key={tool.route} type="button" aria-current={route === tool.route ? 'page' : undefined} data-tool={tool.route} className={route === tool.route ? 'active' : ''} onClick={() => navigate(tool.route)}>{tool.label}</button>)}</nav>;
}
