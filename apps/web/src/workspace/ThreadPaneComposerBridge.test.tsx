import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ThreadPaneComposerBridge } from "../composer/ThreadPaneComposerBridge";
import type { ComposerSettings } from "../ComposerFooterControls";
import type { ThreadSettingsResponse } from "../api/client";
import {
  baseRoutes,
  clickMenuItem as clickMenuItemWithDeps,
  mockGateway,
  model,
  requestJson,
  secondThread,
  thread,
} from "../test/mvpAppHarness";
import type { WorkspacePane } from "./paneTypes";
import { WorkspaceProvider, type ThreadComposerState } from "./WorkspaceProvider";

const composerSettings: ComposerSettings = { fast: false, model: model.id };
const multiEffortModel = {
  ...model,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deeper reasoning" },
    { reasoningEffort: "xhigh", description: "Maximum reasoning" },
  ],
};

function clickMenuItem(name: RegExp) {
  return clickMenuItemWithDeps(name, screen, waitFor, fireEvent);
}

function pane(threadId: string, title: string, paneId = `pane-${threadId}`): WorkspacePane {
  return {
    id: paneId,
    kind: "thread",
    target: { mode: "existing", threadId },
    title,
  };
}

function paneComposerState(summary: ThreadComposerState["thread"] = thread as ThreadComposerState["thread"], activeTurnId: string | null = null): ThreadComposerState {
  return {
    activeTurnId,
    isActive: true,
    isReady: true,
    publishThreadPaneTimelineAction: () => undefined,
    selectedThreadPresent: true,
    thread: summary,
  };
}

function renderBridgePair({
  firstPane = pane("thread-1", "Implement frontend"),
  firstThread = thread as ThreadComposerState["thread"],
  firstActiveTurnId = null,
  models = [model],
  secondPane = pane("thread-2", "Second thread"),
  secondThreadSummary = secondThread as ThreadComposerState["thread"],
}: {
  firstPane?: WorkspacePane;
  firstThread?: ThreadComposerState["thread"];
  firstActiveTurnId?: string | null;
  models?: typeof model[];
  secondPane?: WorkspacePane;
  secondThreadSummary?: ThreadComposerState["thread"];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function BridgePair() {
    const bridgeProps = {
      composerDefaults: composerSettings,
      contextUsageByThreadId: {},
      composerDraftStore: new Map(),
      hydrateComposerDefaults: async () => composerSettings,
      isDraftComposerTransitioning: false,
      models,
      onCreateDraftThread: vi.fn(),
      onError: vi.fn(),
      onImageOpen: vi.fn(),
      onImagePreviewUrlsChanged: vi.fn(),
      onQueuedInputDeleted: vi.fn(),
      onQueuedInputUpsert: vi.fn(),
      onThreadMaterialized: vi.fn(),
      onThreadTurnStartFailed: vi.fn(),
      onThreadTurnStarted: vi.fn(),
      projects: [],
      skillsInvalidationGeneration: 0,
    };

    return (
      <>
        <section aria-label="First thread pane">
          <ThreadPaneComposerBridge
            {...bridgeProps}
            pane={firstPane}
            paneState={paneComposerState(firstThread, firstActiveTurnId)}
          />
        </section>
        <section aria-label="Second thread pane">
          <ThreadPaneComposerBridge
            {...bridgeProps}
            pane={secondPane}
            paneState={paneComposerState(secondThreadSummary)}
          />
        </section>
      </>
    );
  }

  render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <WorkspaceProvider>
          <BridgePair />
        </WorkspaceProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe("ThreadPaneComposerBridge", () => {
  it("keeps rejected picker intent out of shared settings and retains draft text for an options-free send", async () => {
    const gateway = mockGateway(baseRoutes({
      "GET /v1/threads/thread-1/settings": { model: model.id, effort: "medium", serviceTier: null, activePermissionProfile: null },
      "PATCH /v1/threads/thread-1/settings": () => new Response(JSON.stringify({ message: "Native change rejected", code: "rejected", retryable: false }), { status: 400, headers: { "content-type": "application/json" } }),
    }));
    renderBridgePair({ models: [multiEffortModel] });
    const first = within(screen.getByRole("region", { name: /first thread pane/i }));
    await userEvent.type(first.getByLabelText(/message composer/i), "Keep my unsent text");
    await userEvent.click(await first.findByRole("button", { name: "Model: gpt-5.4, medium" }));
    await clickMenuItem(/^high$/i);
    expect(await first.findByRole("alert")).toHaveTextContent("Native change rejected");
    expect(first.getByRole("button", { name: "Model: gpt-5.4, medium" })).toBeInTheDocument();
    expect(first.getByLabelText(/message composer/i)).toHaveValue("Keep my unsent text");
    await userEvent.click(first.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1));
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toEqual({ input: [{ text: "Keep my unsent text", type: "text" }] });
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(1);
    await userEvent.click(first.getByRole("button", { name: "Reload settings" }));
    await waitFor(() => expect(first.queryByRole("alert")).not.toBeInTheDocument());
  });

  it.each([
    { activeTurnId: null, endpoint: "input" },
    { activeTurnId: "native-active-turn", endpoint: "queued-inputs" },
  ])("allows $endpoint without settings options when the native settings read fails", async ({ activeTurnId, endpoint }) => {
    const gateway = mockGateway(baseRoutes({
      "GET /v1/threads/thread-1/settings": () => new Response(JSON.stringify({ message: "Settings offline", code: "offline", retryable: true }), { status: 503, headers: { "content-type": "application/json" } }),
    }));
    renderBridgePair({ firstActiveTurnId: activeTurnId });
    const first = within(screen.getByRole("region", { name: /first thread pane/i }));
    expect(await first.findByRole("button", { name: "Chat settings unavailable" })).toBeDisabled();
    await userEvent.type(first.getByLabelText(/message composer/i), "Use native execution settings");
    await userEvent.click(first.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`)).toHaveLength(1));
    await expect(requestJson(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`)[0])).resolves.toEqual({ input: [{ text: "Use native execution settings", type: "text" }] });
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);
  });

  it("keeps open thread panes independently composable", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads/thread-1/input": { payload: {} },
        "POST /v1/threads/thread-2/input": { payload: {} },
      }),
    );

    renderBridgePair();

    expect(screen.getAllByLabelText(/message composer/i)).toHaveLength(2);
    const secondPane = screen.getByRole("region", { name: /second thread pane/i });
    await userEvent.type(within(secondPane).getByLabelText(/message composer/i), "Reply in pane two");
    await userEvent.click(within(secondPane).getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-2/input")[0])).resolves.toMatchObject({
      input: [{ text: "Reply in pane two", type: "text" }],
    });
  });

  it("edits only one chat's native future settings and leaves normal input options empty", async () => {
    let secondSettings: ThreadSettingsResponse = { model: multiEffortModel.id, effort: "medium", serviceTier: null, activePermissionProfile: null };
    const gateway = mockGateway(baseRoutes({
      "GET /v1/threads/thread-1/settings": { ...secondSettings, effort: "high" },
      "GET /v1/threads/thread-2/settings": () => ({ ...secondSettings }),
      "PATCH /v1/threads/thread-2/settings": async (request: Request) => {
        secondSettings = { ...secondSettings, ...await requestJson(request) };
        return {};
      },
    }));
    renderBridgePair({ models: [multiEffortModel] });
    const firstPane = within(screen.getByRole("region", { name: /first thread pane/i }));
    const secondPane = within(screen.getByRole("region", { name: /second thread pane/i }));
    await firstPane.findByRole("button", { name: "Model: gpt-5.4, high" });
    await userEvent.click(await secondPane.findByRole("button", { name: "Model: gpt-5.4, medium" }));
    await clickMenuItem(/^xhigh$/i);
    await secondPane.findByRole("button", { name: "Model: gpt-5.4, xhigh" });
    expect(firstPane.getByRole("button", { name: "Model: gpt-5.4, high" })).toBeInTheDocument();
    await expect(requestJson(gateway.callsFor("PATCH", "/v1/threads/thread-2/settings")[0])).resolves.toEqual({ effort: "xhigh" });
    for (const [pane, id] of [[firstPane, "thread-1"], [secondPane, "thread-2"]] as const) {
      await userEvent.type(pane.getByLabelText(/message composer/i), "Use the current native settings");
      await userEvent.click(pane.getByRole("button", { name: /send message/i }));
      await waitFor(() => expect(gateway.callsFor("POST", `/v1/threads/${id}/input`)).toHaveLength(1));
      await expect(requestJson(gateway.callsFor("POST", `/v1/threads/${id}/input`)[0])).resolves.toEqual({
        input: [{ text: "Use the current native settings", type: "text" }],
      });
    }
  });

  it("makes duplicated panes share native settings while retaining their own unsent text", async () => {
    let settings: ThreadSettingsResponse = { model: multiEffortModel.id, effort: "high", serviceTier: null, activePermissionProfile: null };
    const gateway = mockGateway(baseRoutes({
      "GET /v1/threads/thread-1/settings": () => ({ ...settings }),
      "PATCH /v1/threads/thread-1/settings": async (request: Request) => {
        settings = { ...settings, ...await requestJson(request) };
        return {};
      },
    }));
    renderBridgePair({
      firstPane: pane("thread-1", "Implement frontend", "pane-thread-1-a"),
      models: [multiEffortModel],
      secondPane: pane("thread-1", "Duplicate thread", "pane-thread-1-b"),
      secondThreadSummary: thread as ThreadComposerState["thread"],
    });
    const firstPane = within(screen.getByRole("region", { name: /first thread pane/i }));
    const secondPane = within(screen.getByRole("region", { name: /second thread pane/i }));
    await firstPane.findByRole("button", { name: "Model: gpt-5.4, high" });
    await userEvent.type(firstPane.getByLabelText(/message composer/i), "First draft");
    await userEvent.type(secondPane.getByLabelText(/message composer/i), "Second draft");
    await userEvent.click(secondPane.getByRole("button", { name: "Model: gpt-5.4, high" }));
    await clickMenuItem(/^xhigh$/i);
    for (const pane of [firstPane, secondPane]) {
      await pane.findByRole("button", { name: "Model: gpt-5.4, xhigh" });
      expect(pane.getByText("Next turn")).toBeInTheDocument();
    }
    expect(firstPane.getByLabelText(/message composer/i)).toHaveValue("First draft");
    expect(secondPane.getByLabelText(/message composer/i)).toHaveValue("Second draft");
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(1);
  });
});
