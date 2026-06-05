import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  baseRoutes,
  mockGateway,
  projectionPatchEvent,
  setInitialWorkspacePaneState,
} from "./test/mvpAppHarness";
import type { AppSurfaceSession } from "./api/client";

describe("app surface pane integration", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("renders generated UI as a workspace pane and subscribes once for the target thread", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/app-surface": { session: appSurfaceSession() },
        "GET /v1/app-surfaces/session-1/document": appSurfaceDocument,
      }),
    );
    seedGeneratedUiWorkspace();

    render(<App />);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();
    expect(await screen.findByText("Hello from Codex")).toBeInTheDocument();
    await waitFor(() => {
      const workspaceStreams = FakeEventSource.instances.filter((source) => source.url.includes("threadIds=thread-1"));
      expect(workspaceStreams).toHaveLength(1);
      expect(workspaceStreams[0].url).toContain("includeGlobal=true");
    });
  });

  it("converges generated UI revisions and archived state from the workspace stream", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/app-surface": { session: appSurfaceSession() },
        "GET /v1/app-surfaces/session-1/document": appSurfaceDocument,
      }),
    );
    seedGeneratedUiWorkspace();

    render(<App />);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();

    const followUpSession = appSurfaceSession({
      documentUrl: "/v1/app-surfaces/session-1/document?revision=2",
      revision: 2,
      title: "Follow-up mockups",
    });
    emitAppSurfaceEvent("app_surface.session_upserted", followUpSession);

    expect(await screen.findByTitle(/app surface: follow-up mockups/i)).toBeInTheDocument();

    emitAppSurfaceEvent("app_surface.session_archived", {
      ...followUpSession,
      archivedAt: "2026-04-30T00:00:05Z",
      status: "archived",
    });

    await waitFor(() => {
      expect(screen.queryByTitle(/app surface: follow-up mockups/i)).not.toBeInTheDocument();
    });
  });

  it("submits generated UI output and applies the resulting thread patch through the workspace stream", async () => {
    let resolveBridge: (value: unknown) => void = () => undefined;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/app-surface": { session: appSurfaceSession() },
        "GET /v1/app-surfaces/session-1/document": appSurfaceDocument,
        "POST /v1/app-surfaces/session-1/bridge": () =>
          new Promise((resolve) => {
            resolveBridge = resolve;
          }),
      }),
    );
    seedGeneratedUiWorkspace();

    render(<App />);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();

    postAppSurfaceMessage({
      type: "kodex.generatedUi.submit",
      requestId: "submit-1",
      sessionId: "session-1",
      revision: 1,
      message: "Pick mockup A",
      metadata: { choice: "a" },
    });

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/app-surfaces/session-1/bridge")).toHaveLength(1);
    });
    await expect(gateway.callsFor("POST", "/v1/app-surfaces/session-1/bridge")[0].json()).resolves.toEqual({
      bridgeToken: "bridge-token-1",
      id: "submit-1",
      method: "ui/message",
      params: {
        message: "Pick mockup A",
        metadata: { choice: "a" },
      },
      revision: 1,
    });

    act(() => {
      workspaceStream()?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "projection-generated-ui-submit",
        seq: 7,
        threadId: "thread-1",
        turnId: "turn-generated-ui",
        itemId: "user-generated-ui",
        itemType: "userMessage",
        text: "Pick mockup A",
        displayOrder: 7,
        status: "completed",
      }));
      resolveBridge({
        id: "submit-1",
        result: {
          input: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-generated-ui" } },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText("Pick mockup A")).toHaveLength(1);
    });
  });
});

function postAppSurfaceMessage(data: unknown) {
  const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: iframe.contentWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}

function emitAppSurfaceEvent(kind: string, session: AppSurfaceSession) {
  act(() => {
    workspaceStream()?.emitNamed(kind, {
      codexMethod: null,
      id: `event-${kind}-${session.revision}`,
      itemId: null,
      kind,
      payload: session,
      projectId: null,
      receivedAt: "2026-04-30T00:00:00Z",
      seq: session.revision + 10,
      threadId: session.threadId,
      turnId: null,
    });
  });
}

function workspaceStream() {
  return FakeEventSource.instances.find((source) => source.url.includes("threadIds=thread-1"));
}

function seedGeneratedUiWorkspace() {
  setInitialWorkspacePaneState({
    activePaneId: "pane-generated-ui-1",
    dockviewLayout: {
      panes: [{ id: "pane-thread-1" }, { id: "pane-generated-ui-1" }],
    },
    panes: [
      {
        id: "pane-thread-1",
        kind: "thread",
        target: { mode: "existing", threadId: "thread-1" },
        title: "Implement frontend",
      },
      {
        id: "pane-generated-ui-1",
        kind: "generatedUi",
        target: { mode: "latest", threadId: "thread-1" },
        title: "Generated UI",
      },
    ],
    schemaVersion: 1,
  });
}

function appSurfaceDocument() {
  return new Response("<main>Generated UI</main>", {
    headers: { "Content-Type": "text/html" },
  });
}

function appSurfaceSession(overrides: Partial<AppSurfaceSession> = {}): AppSurfaceSession {
  return {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    csp: { connectDomains: [], resourceDomains: [] },
    displayModes: ["pane"],
    documentUrl: "/v1/app-surfaces/session-1/document?revision=1",
    fallbackContent: "Generated mockups",
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
    title: "Generated mockups",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}
