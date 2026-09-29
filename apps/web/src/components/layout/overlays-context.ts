import { createContext, useContext } from 'react';

export interface Overlays {
  openSearch: () => void;
  openHelp: () => void;
}

export const OverlaysContext = createContext<Overlays | null>(null);

/** Opens the workspace search or the help dialog from anywhere inside the dashboard layout. */
export function useOverlays(): Overlays {
  const ctx = useContext(OverlaysContext);
  if (!ctx) throw new Error('useOverlays must be used within <OverlaysProvider>');
  return ctx;
}
