import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import type { Route } from '../types';

/** Page-owned controls share the single app header, including project detail. */
export function PageHeaderSlots({ title, actions, onBack, backLabel = 'Back', route: owner }: { title?: string; actions?: ReactNode; onBack?: () => void; backLabel?: string; route?: Route }) {
  const { route } = useWorkspace();
  const [initialRoute] = useState(route);
  const [slots, setSlots] = useState<{ title: HTMLElement | null; actions: HTMLElement | null; back: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    setSlots({ title: document.getElementById('page-header-title'), actions: document.getElementById('page-header-actions'), back: document.getElementById('page-header-back') });
  }, [route]);
  if (!slots || route !== (owner || initialRoute)) return null;
  return <>
    {title && slots.title && createPortal(<span className="wireframe-header-title">{title}</span>, slots.title)}
    {actions && slots.actions && createPortal(<div className="wireframe-header-actions">{actions}</div>, slots.actions)}
    {onBack && slots.back && createPortal(<button className="reference-header-button wireframe-header-back" type="button" aria-label={backLabel} onClick={onBack}><ChevronLeft size={26} /></button>, slots.back)}
  </>;
}
