import { useCallback, useEffect, useRef, useState } from "react";

import {
  createFederationCatalogSubscription,
  type CatalogEvent,
  type FederatedCatalog,
  type FederatorClient,
  type QualifiedCatalogRef,
} from "../api/federatorClient";

export type FederatorCatalogClient = Pick<FederatorClient, "getCatalog" | "moveCatalogItem" | "refreshCatalog">;
export type CatalogSubscription = (options: { onEvent: (event: CatalogEvent) => void }) => () => void;

export function useFederatedCatalog({
  client,
  subscribe = createFederationCatalogSubscription,
}: {
  client: FederatorCatalogClient;
  subscribe?: CatalogSubscription;
}) {
  const [catalog, setCatalog] = useState<FederatedCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const catalogRef = useRef(catalog);
  const mountedRef = useRef(true);
  catalogRef.current = catalog;

  const applyCatalog = useCallback((next: FederatedCatalog) => {
    if (!mountedRef.current) return;
    setCatalog((current) => {
      if (current && (next.revision < current.revision || next.orderRevision < current.orderRevision)) return current;
      catalogRef.current = next;
      return next;
    });
    setError(null);
  }, []);

  const readCatalog = useCallback(async () => {
    try {
      applyCatalog(await client.getCatalog());
    } catch {
      if (mountedRef.current) setError("Unable to load federated navigation.");
    }
  }, [applyCatalog, client]);

  const refresh = useCallback(async () => {
    if (mountedRef.current) setRefreshing(true);
    try {
      applyCatalog(await client.refreshCatalog());
    } catch {
      if (mountedRef.current) setError("Unable to refresh federated navigation.");
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [applyCatalog, client]);

  const readThenRefresh = useCallback(async () => {
    await readCatalog();
    await refresh();
  }, [readCatalog, refresh]);

  const moveItem = useCallback(async (
    kind: "project" | "pinned",
    item: QualifiedCatalogRef,
    before: QualifiedCatalogRef | null,
  ) => {
    const current = catalogRef.current;
    if (!current) throw new Error("Federated navigation has not loaded.");
    let moved: Awaited<ReturnType<FederatorCatalogClient["moveCatalogItem"]>>;
    try {
      moved = await client.moveCatalogItem(kind, { item, before, orderRevision: current.orderRevision });
    } catch (cause) {
      await readCatalog();
      throw cause;
    }
    if (mountedRef.current) {
      setCatalog((latest) => {
        if (!latest || moved.orderRevision < latest.orderRevision) return latest;
        const next = {
          ...latest,
          orderRevision: moved.orderRevision,
          ...(kind === "project" ? { projectOrder: moved.items } : { pinnedOrder: moved.items }),
        };
        catalogRef.current = next;
        return next;
      });
    }
    void readCatalog();
    return moved;
  }, [client, readCatalog]);

  useEffect(() => {
    mountedRef.current = true;
    void readThenRefresh();
    const unsubscribe = subscribe({ onEvent: () => { void readCatalog(); } });
    const recover = () => { void readThenRefresh(); };
    window.addEventListener("online", recover);
    window.addEventListener("pageshow", recover);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      window.removeEventListener("online", recover);
      window.removeEventListener("pageshow", recover);
    };
  }, [readCatalog, readThenRefresh, subscribe]);

  return { catalog, error, moveItem, refresh, refreshing };
}
