import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ThreadPaneComposerBridge } from "../App";
import type { ComposerSettings } from "../ComposerFooterControls";
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

function paneComposerState(summary: ThreadComposerState["thread"] = thread as ThreadComposerState["thread"]): ThreadComposerState {
  return {
    activeTurnId: null,
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
  models = [model],
  secondPane = pane("thread-2", "Second thread"),
  secondThreadSummary = secondThread as ThreadComposerState["thread"],
}: {
  firstPane?: WorkspacePane;
  firstThread?: ThreadComposerState["thread"];
  models?: typeof model[];
  secondPane?: WorkspacePane;
  secondThreadSummary?: ThreadComposerState["thread"];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function BridgePair() {
    const [paneComposerSettingsByPaneId, setPaneComposerSettingsByPaneId] = useState<Record<string, ComposerSettings>>({});
    const handlePaneComposerSettingsChange = useCallback((paneId: string, settings: ComposerSettings) => {
      setPaneComposerSettingsByPaneId((current) => {
        const existing = current[paneId];
        if (
          existing &&
          existing.fast === settings.fast &&
          existing.model === settings.model &&
          existing.effort === settings.effort
        ) {
          return current;
        }
        return { ...current, [paneId]: settings };
      });
    }, []);
    const bridgeProps = {
      composerDefaults: composerSettings,
      contextUsageByThreadId: {},
      composerDraftStore: new Map(),
      composerSettingsError: null,
      hydrateComposerDefaults: async () => composerSettings,
      isDraftComposerTransitioning: false,
      models,
      onCreateDraftThread: vi.fn(),
      onError: vi.fn(),
      onImageOpen: vi.fn(),
      onImagePreviewUrlsChanged: vi.fn(),
      onQueuedInputDeleted: vi.fn(),
      onQueuedInputUpsert: vi.fn(),
      onPaneComposerSettingsChange: handlePaneComposerSettingsChange,
      onThreadMaterialized: vi.fn(),
      onThreadTurnStartFailed: vi.fn(),
      onThreadTurnStarted: vi.fn(),
      paneComposerSettingsByPaneId,
      projects: [],
      skillsInvalidationGeneration: 0,
      threadComposerDefaults: composerSettings,
    };

    return (
      <>
        <section aria-label="First thread pane">
          <ThreadPaneComposerBridge
            {...bridgeProps}
            pane={firstPane}
            paneState={paneComposerState(firstThread)}
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

  it("keeps pane model settings local until each pane submits", async () => {
    const firstThread = {
      ...thread,
      model: multiEffortModel.id,
      reasoningEffort: "high",
      serviceTier: null,
      rawPayload: {},
    } as ThreadComposerState["thread"];
    const secondThreadSummary = {
      ...secondThread,
      model: multiEffortModel.id,
      reasoningEffort: "medium",
      serviceTier: null,
      rawPayload: {},
    } as ThreadComposerState["thread"];
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads/thread-1/input": { payload: {} },
        "POST /v1/threads/thread-2/input": { payload: {} },
      }),
    );

    renderBridgePair({ firstThread, models: [multiEffortModel], secondThreadSummary });

    const firstPane = screen.getByRole("region", { name: /first thread pane/i });
    const secondPane = screen.getByRole("region", { name: /second thread pane/i });
    expect(within(firstPane).getByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(within(secondPane).getByRole("button", { name: /model: gpt-5\.4, medium/i })).toBeInTheDocument();

    await userEvent.click(within(secondPane).getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^xhigh$/i);

    expect(within(secondPane).getByRole("button", { name: /model: gpt-5\.4, xhigh/i })).toBeInTheDocument();
    expect(within(firstPane).getByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-2/settings")).toHaveLength(0);

    await userEvent.type(within(firstPane).getByLabelText(/message composer/i), "Use high");
    await userEvent.click(within(firstPane).getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1));
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toMatchObject({
      effort: "high",
      model: multiEffortModel.id,
    });

    await userEvent.type(within(secondPane).getByLabelText(/message composer/i), "Use xhigh");
    await userEvent.click(within(secondPane).getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1));
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-2/input")[0])).resolves.toMatchObject({
      effort: "xhigh",
      model: multiEffortModel.id,
    });
  });

  it("keeps duplicated same-thread panes independently configurable until submit", async () => {
    const sameThread = {
      ...thread,
      model: multiEffortModel.id,
      reasoningEffort: "high",
      serviceTier: null,
      rawPayload: {},
    } as ThreadComposerState["thread"];
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    renderBridgePair({
      firstPane: pane("thread-1", "Implement frontend", "pane-thread-1-a"),
      firstThread: sameThread,
      models: [multiEffortModel],
      secondPane: pane("thread-1", "Duplicate thread", "pane-thread-1-b"),
      secondThreadSummary: sameThread,
    });

    const firstPane = screen.getByRole("region", { name: /first thread pane/i });
    const secondPane = screen.getByRole("region", { name: /second thread pane/i });
    expect(within(firstPane).getByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(within(secondPane).getByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();

    await userEvent.click(within(secondPane).getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickMenuItem(/^xhigh$/i);

    expect(within(secondPane).getByRole("button", { name: /model: gpt-5\.4, xhigh/i })).toBeInTheDocument();
    expect(within(firstPane).getByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);

    await userEvent.type(within(firstPane).getByLabelText(/message composer/i), "Use high");
    await userEvent.click(within(firstPane).getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1));
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toMatchObject({
      effort: "high",
      input: [{ text: "Use high", type: "text" }],
      model: multiEffortModel.id,
    });

    await userEvent.type(within(secondPane).getByLabelText(/message composer/i), "Use xhigh");
    await userEvent.click(within(secondPane).getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(2));
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[1])).resolves.toMatchObject({
      effort: "xhigh",
      input: [{ text: "Use xhigh", type: "text" }],
      model: multiEffortModel.id,
    });
  });
});
