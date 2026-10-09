import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

import type { ThreadDeliveryOptions } from "../api/client";

// Delivery and visibility are per-tab preferences. Preference changes do not initiate history reads.

const DEFAULT_OPTIONS = { includeDebugEvents: false, includeCommandOutputs: false };
const ThreadDeliveryContext = createContext({ ...DEFAULT_OPTIONS, getOptions: () => DEFAULT_OPTIONS });

export function ThreadDeliveryProvider({
  children,
  includeDebugEvents = false,
  includeCommandOutputs = false,
}: ThreadDeliveryOptions & { children: ReactNode }) {
  const latest = useRef(DEFAULT_OPTIONS);
  latest.current = { includeDebugEvents, includeCommandOutputs };
  const getOptions = useCallback(() => latest.current, []);
  const value = useMemo(() => ({ includeDebugEvents, includeCommandOutputs, getOptions }), [includeDebugEvents, includeCommandOutputs, getOptions]);
  return <ThreadDeliveryContext.Provider value={value}>{children}</ThreadDeliveryContext.Provider>;
}

export function useThreadDeliveryPreferences() {
  return useContext(ThreadDeliveryContext);
}
