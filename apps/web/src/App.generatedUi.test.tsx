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
import type { GeneratedUiSession } from "./api/client";

describe("generated UI pane integration", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("renders generated UI for the selected thread and reopens it from the thread header", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/generated-ui": { session: generatedUiSession() },
        "GET /v1/generated-ui/sessions/session-1/document": generatedUiDocument,
      }),
    );

    render(<App />);

    expect(await screen.findByTitle(/generated ui: generated mockups/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /hide generated ui/i }));

    await waitFor(() => {
      expect(screen.queryByTitle(/generated ui: generated mockups/i)).not.toBeInTheDocument();
    });
    const showButton = await screen.findByRole("button", { name: /show generated ui/i });

    await userEvent.click(showButton);

    expect(await screen.findByTitle(/generated ui: generated mockups/i)).toBeInTheDocument();
  });

  it("reveals a hidden pane for a new revision and converges submitted state from SSE", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/generated-ui": { session: generatedUiSession() },
        "GET /v1/generated-ui/sessions/session-1/document": generatedUiDocument,
      }),
    );

    render(<App />);

    expect(await screen.findByTitle(/generated ui: generated mockups/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /hide generated ui/i }));
    await screen.findByRole("button", { name: /show generated ui/i });

    const followUpSession = generatedUiSession({
      documentUrl: "/v1/generated-ui/sessions/session-1/document?revision=2",
      revision: 2,
      title: "Follow-up mockups",
    });
    emitGeneratedUiEvent("generated_ui.session_upserted", followUpSession);

    expect(await screen.findByTitle(/generated ui: follow-up mockups/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show generated ui/i })).not.toBeInTheDocument();

    emitGeneratedUiEvent("generated_ui.session_submitted", {
      ...followUpSession,
      status: "submitted",
      submitAvailable: false,
      submittedMessage: "Pick mockup B",
      submittedRevision: 2,
    });

    expect(await screen.findByText(/submitted/i)).toBeInTheDocument();
    postGeneratedUiSubmit({
      type: "kodex.ui.submit",
      sessionId: "session-1",
      revision: 2,
      message: "Submit after SSE",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/already been submitted/i);
    expect(gateway.callsFor("POST", "/v1/generated-ui/sessions/session-1/submit")).toHaveLength(0);
  });

  it("submits generated UI output as a visible user message", async () => {
    const submittedSession = {
      ...generatedUiSession(),
      status: "submitted",
      submitAvailable: false,
      submittedMessage: "Pick mockup A",
      submittedRevision: 1,
    };
    let resolveSubmit: (value: unknown) => void = () => undefined;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/generated-ui": { session: generatedUiSession() },
        "GET /v1/generated-ui/sessions/session-1/document": generatedUiDocument,
        "POST /v1/generated-ui/sessions/session-1/submit": () =>
          new Promise((resolve) => {
            resolveSubmit = resolve;
          }),
      }),
    );

    render(<App />);

    expect(await screen.findByTitle(/generated ui: generated mockups/i)).toBeInTheDocument();

    postGeneratedUiSubmit({
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
      resolveSubmit({
        input: { disposition: "started", queuedInput: null, rawPayload: { turnId: "turn-generated-ui" } },
        session: submittedSession,
      });
    });

    await waitFor(() => {
      expect(within(timelineElement(document.body)).getAllByText("Pick mockup A")).toHaveLength(1);
    });
    await screen.findByText(/submitted/i);
    expect(gateway.callsFor("POST", "/v1/generated-ui/sessions/session-1/submit")).toHaveLength(1);
    await expect(gateway.callsFor("POST", "/v1/generated-ui/sessions/session-1/submit")[0].json()).resolves.toEqual({
      revision: 1,
      message: "Pick mockup A",
    });
  });
});

function postGeneratedUiSubmit(data: unknown) {
  const iframe = screen.getByTitle(/generated ui:/i) as HTMLIFrameElement;
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

function emitGeneratedUiEvent(kind: string, session: GeneratedUiSession) {
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

function generatedUiDocument() {
  return new Response("<main>Generated UI</main>", {
    headers: { "Content-Type": "text/html" },
  });
}

function generatedUiSession(overrides: Partial<GeneratedUiSession> = {}): GeneratedUiSession {
  return {
    archivedAt: null,
    createdAt: "2026-04-30T00:00:00Z",
    documentUrl: "/v1/generated-ui/sessions/session-1/document?revision=1",
    id: "session-1",
    networkPolicy: "self_contained",
    revision: 1,
    status: "interactive",
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
