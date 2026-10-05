import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { AppSurfaceSession, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyAppSurfaceEvent } from "./cache";

describe("app surface cache events", () => {
  it.each([false, true])("refills authoritative current state after an older replayed event (archived=%s)", async (archived) => {
    const current = archived ? null : appSurfaceSession({ revision: 3, title: "Current gateway session" });
    const client = new QueryClient();
    const read = vi.fn().mockResolvedValue(current);
    const observer = new QueryObserver(client, { queryKey: queryKeys.appSurface("thread-1"), queryFn: read });
    const cleanup = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(client.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(current));
      applyAppSurfaceEvent(client, appSurfaceEvent("app_surface.session_upserted", appSurfaceSession({ revision: 1, title: "Delayed old event" })));
      expect(client.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(current);
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      expect(client.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(current);
    } finally {
      cleanup();
      client.clear();
    }
  });

  it.each([false, true])("cancels both clients' stale session reads before authoritative refill (archived=%s)", async (archived) => {
    const clients = [new QueryClient(), new QueryClient()];
    const signals: AbortSignal[] = [];
    const releases: Array<(session: AppSurfaceSession) => void> = [];
    const current = archived ? null : appSurfaceSession({ revision: 3, title: "Latest gateway surface" });
    const cleanups = clients.map((client) => {
      let reads = 0;
      const observer = new QueryObserver(client, {
        queryKey: queryKeys.appSurface("thread-1"),
        queryFn: ({ signal }) => {
          if (reads++ > 0) return Promise.resolve(current);
          signals.push(signal);
          return new Promise<AppSurfaceSession>((resolve) => releases.push(resolve));
        },
      });
      return observer.subscribe(() => {});
    });
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      for (const client of clients) {
        applyAppSurfaceEvent(client, appSurfaceEvent("app_surface.session_upserted", appSurfaceSession({ revision: 2 })));
        applyAppSurfaceEvent(client, appSurfaceEvent("app_surface.session_upserted", appSurfaceSession({ revision: 3 })));
        if (archived) applyAppSurfaceEvent(client, appSurfaceEvent("app_surface.session_archived", appSurfaceSession({ revision: 3 })));
      }
      await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
      releases.forEach((release) => release(appSurfaceSession({ revision: 1, title: "Captured obsolete surface" })));
      await vi.waitFor(() => {
        for (const client of clients) {
          expect(client.getQueryState(queryKeys.appSurface("thread-1"))?.fetchStatus).toBe("idle");
          expect(client.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(current);
        }
      });
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      clients.forEach((client) => client.clear());
    }
  });

  it("refills archived state without interpreting event payloads", async () => {
    const queryClient = new QueryClient();
    let current: AppSurfaceSession | null = appSurfaceSession();
    const read = vi.fn(() => Promise.resolve(current));
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.appSurface("thread-1"), queryFn: read,
    });
    const cleanup = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(queryClient.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(current));
      current = null;
      const previousReads = read.mock.calls.length;
      applyAppSurfaceEvent(queryClient, { ...appSurfaceEvent("app_surface.session_archived", null), threadId: "thread-1" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(previousReads + 1));
      expect(queryClient.getQueryData(queryKeys.appSurface("thread-1"))).toBeNull();
    } finally {
      cleanup();
      queryClient.clear();
    }
  });
});

function appSurfaceEvent(kind: string, session: AppSurfaceSession | null): EventEnvelope {
  return {
    codexMethod: null,
    id: `event-${kind}`,
    itemId: null,
    kind,
    payload: session,
    projectId: null,
    receivedAt: "2026-04-30T00:00:00Z",
    seq: 1,
    threadId: session?.threadId ?? null,
    turnId: null,
  };
}

function appSurfaceSession(overrides: Partial<AppSurfaceSession> = {}): AppSurfaceSession {
  return {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    csp: { connectDomains: [], resourceDomains: [] },
    displayModes: ["pane"],
    documentUrl: "/v1/app-surfaces/session-1/document?revision=1",
    fallbackContent: "Mockups",
    grants: { canOpenLinks: false, canSendMessage: true, canUpdateModelContext: false, resources: [], tools: [] },
    bridgeToken: "bridge-token-1",
    id: "session-1",
    provenance: { source: "test" },
    permissions: {},
    provider: "generated",
    resourceMimeType: "text/html",
    resourceUri: "ui://kodex/generated/session-1",
    revision: 1,
    status: "active",
    threadId: "thread-1",
    title: "Mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
