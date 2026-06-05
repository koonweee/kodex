import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { AppSurfaceSession, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyAppSurfaceEvent } from "./cache";

describe("app surface cache events", () => {
  it("updates and archives the active app surface for a thread", () => {
    const queryClient = new QueryClient();
    const active = appSurfaceSession({ revision: 1, status: "active" });
    const submitted = appSurfaceSession({
      revision: 2,
      status: "submitted",
      submittedMessage: "Pick mockup A",
      submittedRevision: 2,
    });

    applyAppSurfaceEvent(queryClient, appSurfaceEvent("app_surface.session_upserted", active));
    expect(queryClient.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(active);

    applyAppSurfaceEvent(queryClient, appSurfaceEvent("app_surface.session_submitted", submitted));
    expect(queryClient.getQueryData(queryKeys.appSurface("thread-1"))).toEqual(submitted);

    applyAppSurfaceEvent(queryClient, appSurfaceEvent("app_surface.session_archived", submitted));
    expect(queryClient.getQueryData(queryKeys.appSurface("thread-1"))).toBeNull();
  });

  it("archives by event thread id when the payload is empty", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.appSurface("thread-1"), appSurfaceSession());

    applyAppSurfaceEvent(queryClient, {
      ...appSurfaceEvent("app_surface.session_archived", null),
      threadId: "thread-1",
    });

    expect(queryClient.getQueryData(queryKeys.appSurface("thread-1"))).toBeNull();
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
    provider: "generated",
    resourceMimeType: "text/html",
    resourceUri: "ui://kodex/generated/session-1",
    revision: 1,
    status: "active",
    submitAvailable: true,
    submittedAt: null,
    submittedMessage: null,
    submittedMetadata: null,
    submittedRevision: null,
    threadId: "thread-1",
    title: "Mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
