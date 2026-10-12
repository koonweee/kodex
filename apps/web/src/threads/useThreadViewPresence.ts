import { useEffect, useMemo, useRef } from "react";

import {
  type ThreadViewPresenceSnapshotRequest,
} from "../api/client";
import { useExecutorConnection, useGatewayClient } from "../api/GatewayClientContext";

const THREAD_VIEW_PRESENCE_CLIENT_ID_KEY = "kodex.threadViewPresenceClientId";
const DEFAULT_THREAD_VIEW_PRESENCE_HEARTBEAT_MS = 10_000;

let fallbackClientId: string | null = null;

export function useThreadViewPresence({
  enabled,
  heartbeatMs = DEFAULT_THREAD_VIEW_PRESENCE_HEARTBEAT_MS,
  threadIds,
}: {
  enabled: boolean;
  heartbeatMs?: number;
  threadIds: string[];
}) {
  const api = useGatewayClient();
  const connection = useExecutorConnection();
  const presenceWriteLock = `kodex-thread-view-presence:${connection?.executorId ?? "local"}:${connection?.instanceId ?? "current"}`;
  const visibleThreadIds = useMemo(() => normalizedThreadIds(threadIds), [threadIds]);
  const visibleThreadIdsKey = visibleThreadIds.join("\n");
  const latestVisibleThreadIdsRef = useRef<string[]>(visibleThreadIds);
  const clientIdRef = useRef<string | null>(null);
  const lastReportedVisibleThreadIdsKeyRef = useRef("");

  latestVisibleThreadIdsRef.current = visibleThreadIds;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      return;
    }

    if (document.visibilityState === "visible") reportLatestVisibleThreads();
  }, [api, enabled, presenceWriteLock, visibleThreadIdsKey]);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      return;
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    function report(threadIds: string[]) {
      lastReportedVisibleThreadIdsKeyRef.current = threadIds.join("\n");
      const request = presenceRequest(ensureClientId(), threadIds);
      void replaceThreadViewPresence(api, presenceWriteLock, request).catch(() => {
        // Presence is ephemeral. Missed heartbeats expire in the gateway.
      });
    }

    function reportWithBeacon(threadIds: string[]): boolean {
      lastReportedVisibleThreadIdsKeyRef.current = threadIds.join("\n");
      return api.sendThreadViewPresenceSnapshotBeacon(presenceRequest(ensureClientId(), threadIds));
    }

    function clearHeartbeat() {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function reportLatestVisibleThreads() {
      report(latestVisibleThreadIdsRef.current);
    }

    function clearPresence() {
      if (lastReportedVisibleThreadIdsKeyRef.current.length === 0) {
        return;
      }
      report([]);
    }

    function clearPresenceWithBeacon(): boolean {
      if (lastReportedVisibleThreadIdsKeyRef.current.length === 0) {
        return true;
      }
      return reportWithBeacon([]);
    }

    function syncVisibility(reportVisible: boolean) {
      clearHeartbeat();
      if (document.visibilityState === "visible") {
        if (reportVisible) {
          reportLatestVisibleThreads();
        }
        heartbeatTimer = setInterval(() => {
          if (document.visibilityState === "visible") {
            reportLatestVisibleThreads();
          }
        }, heartbeatMs);
        return;
      }
      clearPresence();
    }

    function handlePageHide() {
      if (!clearPresenceWithBeacon()) {
        clearPresence();
      }
    }

    syncVisibility(false);
    const handleVisibilityChange = () => syncVisibility(true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      clearHeartbeat();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      if (!clearPresenceWithBeacon()) {
        clearPresence();
      }
    };
  }, [api, enabled, heartbeatMs, presenceWriteLock]);

  function ensureClientId(): string {
    clientIdRef.current ??= threadViewPresenceClientId();
    return clientIdRef.current;
  }

  function reportLatestVisibleThreads() {
    lastReportedVisibleThreadIdsKeyRef.current = latestVisibleThreadIdsRef.current.join("\n");
    const request = presenceRequest(ensureClientId(), latestVisibleThreadIdsRef.current);
    void replaceThreadViewPresence(
      api,
      presenceWriteLock,
      request,
    ).catch(() => {
      // Presence is ephemeral. Missed heartbeats expire in the gateway.
    });
  }
}

async function replaceThreadViewPresence(
  api: ReturnType<typeof useGatewayClient>,
  lockName: string,
  request: ThreadViewPresenceSnapshotRequest,
) {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") {
    await navigator.locks.request(lockName, () => api.replaceThreadViewPresence(request));
    return;
  }
  await api.replaceThreadViewPresence(request);
}

function presenceRequest(clientId: string, visibleThreadIds: string[]): ThreadViewPresenceSnapshotRequest {
  return { clientId, visibleThreadIds };
}

function normalizedThreadIds(threadIds: string[]): string[] {
  return Array.from(new Set(threadIds.filter((threadId) => threadId.length > 0))).sort();
}

function threadViewPresenceClientId(): string {
  if (typeof sessionStorage !== "undefined") {
    try {
      const existing = sessionStorage.getItem(THREAD_VIEW_PRESENCE_CLIENT_ID_KEY);
      if (existing) {
        return existing;
      }
      const next = createThreadViewPresenceClientId();
      sessionStorage.setItem(THREAD_VIEW_PRESENCE_CLIENT_ID_KEY, next);
      return next;
    } catch {
      // Fall back below when storage is blocked or unavailable.
    }
  }

  fallbackClientId ??= createThreadViewPresenceClientId();
  return fallbackClientId;
}

function createThreadViewPresenceClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `presence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
