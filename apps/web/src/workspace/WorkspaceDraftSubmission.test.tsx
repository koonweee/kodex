import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { expect, it, vi } from "vitest";

import { ThreadPaneComposerBridge } from "../composer/ThreadPaneComposerBridge";
import type { ComposerDraftStore } from "../composer/useComposerDraftState";
import { baseRoutes, mockGateway, model, project } from "../test/mvpAppHarness";
import { createMemoryWorkspacePaneStore } from "./paneStore";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";

it("preserves a submitting draft's project after native creation has cleared its input", async () => {
  const gateway = mockGateway(baseRoutes({
    "POST /v1/threads/thread-1/input": () => new Promise(() => {}),
  }));
  const store = createMemoryWorkspacePaneStore({ schemaVersion: 1, activePaneId: "draft", dockviewLayout: null,
    panes: [{ id: "draft", kind: "thread", target: { mode: "draft", projectId: project.id }, title: "New thread" }],
  });
  const onCreateDraftThread = vi.fn(async () => ({ threadId: "thread-1" }));
  const noop = () => undefined;
  function Drafts() {
    const { workspace, openDraftThreadPane } = useWorkspace();
    const drafts = useRef<ComposerDraftStore>(new Map());
    return <>
      <button onClick={() => void openDraftThreadPane(null)}>New standalone chat</button>
      {workspace.panes.map((pane) => <section aria-label={`Composer ${pane.id}`} key={pane.id}>
        <ThreadPaneComposerBridge pane={pane}
          paneState={{ activeTurnId: null, isActive: pane.id === workspace.activePaneId, isReady: true, selectedThreadPresent: false, publishThreadPaneTimelineAction: noop }}
          projects={[project]} models={[model]} composerDefaults={{ fast: false, model: model.id }}
          composerDraftStore={drafts.current} contextUsageByThreadId={{}} isDraftComposerTransitioning={false}
          hydrateComposerDefaults={async () => null} onCreateDraftThread={onCreateDraftThread}
          onError={noop} onImageOpen={noop} onImagePreviewUrlsChanged={noop} onThreadMaterialized={noop}
          onThreadTurnStarted={noop} onThreadTurnStartFailed={noop} skillsInvalidationGeneration={0}
        />
      </section>)}
    </>;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider paneStore={store}><Drafts /></WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);
  const original = within(screen.getByRole("region", { name: "Composer draft" }));
  const input = original.getByRole("textbox", { name: "Message composer" });
  fireEvent.change(input, { target: { value: "Submit in the original project" } });
  fireEvent.click(original.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1));
  expect(input).toHaveValue("");
  expect(input).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "New standalone chat" }));
  await waitFor(() => expect(store.getState().panes).toHaveLength(2));
  expect(store.getState().panes[0]).toMatchObject({ id: "draft", target: { mode: "draft", projectId: project.id } });
  expect(store.getState().activePaneId).not.toBe("draft");
  expect(onCreateDraftThread).toHaveBeenCalledTimes(1);
});
