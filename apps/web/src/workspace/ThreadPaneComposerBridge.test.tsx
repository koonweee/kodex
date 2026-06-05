import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ThreadPaneComposerBridge } from "../App";
import type { ComposerSettings } from "../ComposerFooterControls";
import {
  baseRoutes,
  mockGateway,
  model,
  requestJson,
  secondThread,
  thread,
} from "../test/mvpAppHarness";
import type { WorkspacePane } from "./paneTypes";
import { WorkspaceProvider, type ThreadComposerState } from "./WorkspaceProvider";

const composerSettings: ComposerSettings = { fast: false, model: model.id };

function pane(threadId: string, title: string): WorkspacePane {
  return {
    id: `pane-${threadId}`,
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

function renderBridgePair() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const firstPane = pane("thread-1", "Implement frontend");
  const secondPane = pane("thread-2", "Second thread");
  const bridgeProps = {
    composerDefaults: composerSettings,
    contextUsageByThreadId: {},
    composerDraftStore: new Map(),
    composerSettingsError: null,
    hydrateComposerDefaults: async () => composerSettings,
    isDraftComposerTransitioning: false,
    models: [model],
    onComposerSettingsError: vi.fn(),
    onCreateDraftThread: vi.fn(),
    onError: vi.fn(),
    onImageOpen: vi.fn(),
    onImagePreviewUrlsChanged: vi.fn(),
    onQueuedInputDeleted: vi.fn(),
    onQueuedInputUpsert: vi.fn(),
    onThreadMaterialized: vi.fn(),
    onThreadTurnStartFailed: vi.fn(),
    onThreadTurnStarted: vi.fn(),
    onThreadUpdated: vi.fn(),
    projects: [],
    skillsInvalidationGeneration: 0,
  };

  render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <WorkspaceProvider>
          <section aria-label="First thread pane">
            <ThreadPaneComposerBridge
              {...bridgeProps}
              pane={firstPane}
              paneState={paneComposerState(thread as ThreadComposerState["thread"])}
            />
          </section>
          <section aria-label="Second thread pane">
            <ThreadPaneComposerBridge
              {...bridgeProps}
              pane={secondPane}
              paneState={paneComposerState(secondThread as ThreadComposerState["thread"])}
            />
          </section>
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
});
