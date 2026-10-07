import { createContext, useContext, type ReactNode } from 'react';
import type { CatalogSnapshot } from './client';

const NativeCatalogContext = createContext<CatalogSnapshot | null>(null);

/** One shell-owned catalog subscription supplies membership to every pane. */
export function NativeCatalogProvider({ snapshot, children }: { snapshot: CatalogSnapshot | null; children: ReactNode }) {
  return <NativeCatalogContext.Provider value={snapshot}>{children}</NativeCatalogContext.Provider>;
}
export function useNativeCatalogSnapshot() { return useContext(NativeCatalogContext); }
