import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { DeviceProvider } from './state/DeviceContext';
import { WorkspaceProvider } from './state/WorkspaceContext';
import './studio.css';
import { reportRuntimeError, runtimeErrorDetails } from './lib/runtimeDiagnostics';
import { AppearanceProvider } from './state/AppearanceContext';
import { StartupReady } from './components/StartupReady';
import './reference-theme.css';
import './theme-consistency.css';
import './wireframe-theme.css';
import './chroma-workflows.css';

const showErrorDetails = import.meta.env.DEV || import.meta.env.VITE_DEBUG_DIAGNOSTICS === 'true';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean; details: string }> {
  state = { error: false, details: '' };
  static getDerivedStateFromError(error: unknown) { return { error: true, details: runtimeErrorDetails(error) }; }
  componentDidCatch(error: Error, info: ErrorInfo) { this.setState({ details: reportRuntimeError(error, info.componentStack || '') }); }
  render() { return this.state.error ? <main><div className="empty-state"><h1>Let’s try that again.</h1><p>The workspace could not load this view. Your saved library is kept in browser storage.</p><button className="btn primary" onClick={() => location.reload()}>Reload CHROMA</button>{showErrorDetails && <details className="mt-3"><summary>Error details</summary><pre style={{ textAlign: 'left', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{this.state.details}</pre></details>}</div></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<StartupReady><ErrorBoundary><AppearanceProvider><DeviceProvider><WorkspaceProvider><App /></WorkspaceProvider></DeviceProvider></AppearanceProvider></ErrorBoundary></StartupReady>);
