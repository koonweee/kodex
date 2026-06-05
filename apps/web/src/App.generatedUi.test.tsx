import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  baseRoutes,
  mockGateway,
  projectionPatchEvent,
  timelineElement,
} from "./test/mvpAppHarness";
import type { AppSurfaceSession } from "./api/client";

describe("app surface pane integration", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("renders an app surface for the selected thread and reopens it from the thread header", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/app-surface": { session: appSurfaceSession() },
        "GET /v1/app-surfaces/session-1/document": appSurfaceDocument,
      }),
    );

    render(<App />);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /hide app surface/i }));

    await waitFor(() => {
      expect(screen.queryByTitle(/app surface: generated mockups/i)).not.toBeInTheDocument();
    });
    const showButton = await screen.findByRole("button", { name: /show app surface/i });

    await userEvent.click(showButton);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();
  });

  it("reveals a hidden pane for a new revision and converges archived state from SSE", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/app-surface": { session: appSurfaceSession() },
        "GET /v1/app-surfaces/session-1/document": appSurfaceDocument,
      }),
    );

    render(<App />);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /hide app surface/i }));
    await screen.findByRole("button", { name: /show app surface/i });

    const followUpSession = appSurfaceSession({
      documentUrl: "/v1/app-surfaces/session-1/document?revision=2",
      revision: 2,
      title: "Follow-up mockups",
    });
    emitAppSurfaceEvent("app_surface.session_upserted", followUpSession);

    expect(await screen.findByTitle(/app surface: follow-up mockups/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show app surface/i })).not.toBeInTheDocument();

    emitAppSurfaceEvent("app_surface.session_archived", {
      ...followUpSession,
      archivedAt: "2026-04-30T00:00:05Z",
      status: "archived",
    });

    await waitFor(() => {
      expect(screen.queryByTitle(/app surface: follow-up mockups/i)).not.toBeInTheDocument();
    });
  });

  it("sends ui/message bridge calls as visible user messages", async () => {
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

    render(<App />);

    expect(await screen.findByTitle(/app surface: generated mockups/i)).toBeInTheDocument();

    postAppSurfaceMessage({
      type: "kodex.generatedUi.submit",
      message: "Pick mockup A",
    });

    expect(await within(timelineElement(document.body)).findByText("Pick mockup A")).toBeInTheDocument();
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    act(() => {
      selectedThreadStream?.emitNamed("thread_view.patch", projectionPatchEvent({
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
        id: "legacy-submit:session-1:1",
        result: {
          input: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-generated-ui" } },
        },
      });
    });

    await waitFor(() => {
      expect(within(timelineElement(document.body)).getAllByText("Pick mockup A")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/app-surfaces/session-1/bridge")).toHaveLength(1);
    await expect(gateway.callsFor("POST", "/v1/app-surfaces/session-1/bridge")[0].json()).resolves.toEqual({
      bridgeToken: "bridge-token-1",
      id: "legacy-submit:session-1:1",
      method: "ui/message",
      params: {
        message: "Pick mockup A",
      },
      revision: 1,
    });
  });
});

function postAppSurfaceMessage(data: unknown) {
  const iframe = screen.getByTitle(/app surface:/i) as HTMLIFrameElement;
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

function emitAppSurfaceEvent(kind: string, session: AppSurfaceSession) {
  act(() => {
    const selectedThreadStream = FakeEventSource.instances.find((source) =>
      source.url.includes(`threadId=${session.threadId}`),
    );
    selectedThreadStream?.emitNamed(kind, {
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
