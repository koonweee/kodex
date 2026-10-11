import { createContext, useContext, type ReactNode } from "react";

import type { FederatedCatalog, FederatedExecutor, QualifiedCatalogRef, RegisterExecutorRequest, UpdateExecutorRequest } from "../api/federatorClient";

export type FederatedCatalogContextValue = {
  catalog: FederatedCatalog | null;
  error: string | null;
  executors: readonly FederatedExecutor[];
  moveItem: (
    kind: "project" | "pinned",
    item: QualifiedCatalogRef,
    before: QualifiedCatalogRef | null,
  ) => Promise<unknown>;
  probeExecutor: (executorId: string) => Promise<FederatedExecutor>;
  registerExecutor: (request: RegisterExecutorRequest) => Promise<FederatedExecutor>;
  removeExecutor: (executorId: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshExecutors: () => Promise<void>;
  refreshing: boolean;
  updateExecutor: (executorId: string, request: UpdateExecutorRequest) => Promise<FederatedExecutor>;
};

const FederatedCatalogContext = createContext<FederatedCatalogContextValue | null>(null);

export function FederatedCatalogProvider({ children, value }: { children: ReactNode; value: FederatedCatalogContextValue }) {
  return <FederatedCatalogContext.Provider value={value}>{children}</FederatedCatalogContext.Provider>;
}

export function useFederatedCatalogContext(): FederatedCatalogContextValue | null {
  return useContext(FederatedCatalogContext);
}
