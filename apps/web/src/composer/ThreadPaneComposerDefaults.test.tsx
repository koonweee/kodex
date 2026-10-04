import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { refreshNativeConfig } from "../api/nativeConfigCache";
import { baseRoutes, clickMenuItem, mockGateway, model } from "../test/mvpAppHarness";
import { WorkspaceProvider } from "../workspace/WorkspaceProvider";
import { ThreadPaneComposerBridge } from "./ThreadPaneComposerBridge";
import { useComposerSettingsState } from "./useComposerSettingsState";

const nativeModel = { ...model, supportedReasoningEfforts: [
  { reasoningEffort: "medium", description: "Balanced" },
  { reasoningEffort: "high", description: "Deeper" },
  { reasoningEffort: "xhigh", description: "Maximum" },
] };
const projects: [] = [];
const ignore = () => {};
const draftStore = new Map();

function Draft() {
  const settings = useComposerSettingsState({ projects, onError: ignore });
  useEffect(() => { void settings.hydrateComposerDefaults(null); }, [settings.hydrateComposerDefaults]);
  return <ThreadPaneComposerBridge {...settings}
    pane={{ id: "draft-pane", kind: "thread", target: { mode: "draft", projectId: null }, title: "New chat" }}
    paneState={{ activeTurnId: null, isActive: true, isReady: true, selectedThreadPresent: false, thread: null, publishThreadPaneTimelineAction: ignore }}
    projects={projects} contextUsageByThreadId={{}} composerDraftStore={draftStore} isDraftComposerTransitioning={false}
    onCreateDraftThread={async () => ({ threadId: "created" })} onError={ignore} onImageOpen={ignore} onImagePreviewUrlsChanged={ignore}
    onQueuedInputDeleted={ignore} onQueuedInputUpsert={ignore} onThreadMaterialized={ignore} onThreadTurnStartFailed={ignore} onThreadTurnStarted={ignore} skillsInvalidationGeneration={0}
  />;
}

afterEach(() => { vi.restoreAllMocks(); draftStore.clear(); });

it("refills a cancelled initial defaults read without losing text or later overwriting an explicit draft choice", async () => {
  let firstRequest: Request | undefined;
  let releaseOld!: (value: unknown) => void;
  const oldReply = new Promise((resolve) => { releaseOld = resolve; });
  let reads = 0;
  let nativeEffort = "high";
  mockGateway(baseRoutes({
    "GET /v1/models": { models: [nativeModel] },
    "GET /v1/composer-settings": (request: Request) => {
      reads += 1;
      if (reads === 1) { firstRequest = request; return oldReply; }
      return { model: model.id, effort: nativeEffort, serviceTier: null, writeTarget: null };
    },
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MantineProvider env="test"><WorkspaceProvider><Draft /></WorkspaceProvider></MantineProvider></QueryClientProvider>);
  await waitFor(() => expect(firstRequest).toBeDefined());
  await userEvent.type(screen.getByLabelText("Message composer"), "Keep this draft");
  await act(async () => { await refreshNativeConfig(client); });
  expect(await screen.findByRole("button", { name: "Model: gpt-5.4, high" })).toBeInTheDocument();
  expect(firstRequest?.signal.aborted).toBe(true);
  await act(async () => { releaseOld({ model: model.id, effort: "medium", writeTarget: null }); });
  expect(screen.getByRole("button", { name: "Model: gpt-5.4, high" })).toBeInTheDocument();
  expect(screen.getByLabelText("Message composer")).toHaveValue("Keep this draft");
  await userEvent.click(screen.getByRole("button", { name: "Model: gpt-5.4, high" }));
  await clickMenuItem(/^xhigh$/i, screen, waitFor, fireEvent);
  nativeEffort = "medium";
  await act(async () => { await refreshNativeConfig(client); });
  expect(screen.getByRole("button", { name: "Model: gpt-5.4, xhigh" })).toBeInTheDocument();
  expect(screen.getByLabelText("Message composer")).toHaveValue("Keep this draft");
});
