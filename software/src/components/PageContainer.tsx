import type { ReactNode } from 'react';
import type { Route } from '../types';

export function PageContainer({ route, hidden = false, children }: { route: Route; hidden?: boolean; children: ReactNode }) {
  return <div data-page={route} hidden={hidden} className="studio-page fade-in">{children}</div>;
}
