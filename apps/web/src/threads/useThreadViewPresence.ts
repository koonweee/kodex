import { useEffect } from "react";

import {
  sendThreadViewPresenceBeacon,
  updateThreadViewPresence,
  type ThreadViewPresenceRequest,
} from "../api/client";

const THREAD_VIEW_PRESENCE_CLIENT_ID_KEY = "kodex.threadViewPresenceClientId";
const DEFAULT_THREAD_VIEW_PRESENCE_HEARTBEAT_MS = 5_000;

let fallbackClientId: string | null = null;

export function useThreadViewPresence({
  enabled,
  heartbeatMs = DEFAULT_THREAD_VIEW_PRESENCE_HEARTBEAT_MS,
  threadId,
}: {
  enabled: boolean;
  heartbeatMs?: number;
  threadId: string | null;
}) {
  useEffect(() => {
    if (!enabled || !threadId || typeof document === "undefined") {
      return;
    }

    const clientId = threadViewPresenceClientId();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastReportedVisible = false;

    function report(visible: boolean) {
      lastReportedVisible = visible;
      void updateThreadViewPresence(threadId as string, presenceRequest(clientId, visible)).catch(() => {
        // Presence is ephemeral. Missed heartbeats expire in the gateway.
      });
    }

    function reportWithBeacon(visible: boolean): boolean {
      lastReportedVisible = visible;
      return sendThreadViewPresenceBeacon(threadId as string, presenceRequest(clientId, visible));
    }

    function clearHeartbeat() {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function syncVisibility() {
      clearHeartbeat();
      if (document.visibilityState === "visible") {
        report(true);
        heartbeatTimer = setInterval(() => {
          if (document.visibilityState === "visible") {
            report(true);
          }
        }, heartbeatMs);
        return;
      }
      if (lastReportedVisible) {
        report(false);
      }
    }

    function handlePageHide() {
      if (!reportWithBeacon(false)) {
        report(false);
      }
    }

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      clearHeartbeat();
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      if (!reportWithBeacon(false)) {
        report(false);
      }
    };
  }, [enabled, heartbeatMs, threadId]);
}

function presenceRequest(clientId: string, visible: boolean): ThreadViewPresenceRequest {
  return { clientId, visible };
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
