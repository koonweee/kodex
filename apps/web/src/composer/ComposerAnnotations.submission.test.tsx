import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { mockGateway, requestJson } from "../test/gatewayMock";
import { ComposerPanel } from "./ComposerPanel";
import { useComposerOrchestration } from "./useComposerOrchestration";

function renderComposer(activeTurnId: string | null) {
  const onError = vi.fn();
  const onOptimisticUserMessageStarted = vi.fn();
  const settings = { model: "native-model", fast: false };
  const draftStore = new Map([["pane:one:thread:thread-1", {
        composerText: "",
        skillBindings: [],
        annotations: [
          { id: "a", text: "Both trim checks passed.", comment: "" },
          { id: "b", text: "Cache cleared.", comment: "Keep this?" },
        ],
      }]]);
  function RetryComposer() {
    const orchestration = useComposerOrchestration({
      activeSelectedTurnId: activeTurnId,
      canCompose: true,
      composerSettings: settings,
      draftChatThreadSelected: false,
      draftThreadProjectId: null,
      isDraftThreadSelected: false,
      onCreateDraftThread: vi.fn(),
      onError,
      onOptimisticUserMessageStarted,
      onThreadMaterialized: vi.fn(),
      onThreadTurnStartFailed: vi.fn(),
      onThreadTurnStarted: vi.fn(),
      selectedProjectId: null,
      selectedThreadId: "thread-1",
    });
    return <ComposerPanel
      activeSelectedTurnId={activeTurnId}
      attachmentInputRef={orchestration.attachmentInputRef}
      canCompose
      composerCwd="/workspace"
      composerDraftKey="pane:one:thread:thread-1"
      composerDraftStore={draftStore}
      composerResetToken={0}
      composerSettings={settings}
      composerSettingsError={null}
      isDraftThreadSelected={false}
      isDraftComposerTransitioning={false}
      isComposerDragActive={orchestration.isComposerDragActive}
      isComposerSubmitting={orchestration.isComposerSubmitting}
      isSelectedTimelineReady
      models={[]}
      onAttachmentInputChange={orchestration.handleAttachmentInputChange}
      onComposerDragLeave={orchestration.handleComposerDragLeave}
      onComposerDragOver={orchestration.handleComposerDragOver}
      onComposerDrop={orchestration.handleComposerDrop}
      onComposerKeyDown={orchestration.handleComposerKeyDown}
      onComposerPaste={orchestration.handleComposerPaste}
      onComposerSettingsChange={vi.fn()}
      onImageOpen={vi.fn()}
      onRemovePendingAttachment={orchestration.removePendingAttachment}
      onStopTurn={orchestration.handleStopTurn}
      onSubmitTurn={orchestration.handleSubmitTurn}
      pendingAttachments={orchestration.pendingAttachments}
      selectedThreadPresent
    />;
  }
  render(<QueryClientProvider client={createKodexQueryClient()}><MantineProvider env="test"><RetryComposer /></MantineProvider></QueryClientProvider>);
  return { onError, onOptimisticUserMessageStarted };
}

describe("annotation submissions", () => {
  it.each([
    { activeTurnId: null, endpoint: "input" },
    { activeTurnId: "active-turn", endpoint: "queued-inputs" },
    { activeTurnId: "active-turn", endpoint: "queued-inputs", shortcut: true },
  ])("sends annotation-only input, removes entries, and restores after rejected $endpoint", async ({ activeTurnId, endpoint, shortcut }) => {
    let attempts = 0;
    const gateway = mockGateway({
      [`POST /v1/threads/thread-1/${endpoint}`]: () => {
        if (++attempts === 1) return new Response(JSON.stringify({ code: "rejected", message: "Native input rejected", retryable: false }), {
          status: 400, headers: { "content-type": "application/json" },
        });
        return endpoint === "input" ? { payload: {} }
          : { queuedInput: { id: "queue-1", threadId: "thread-1", input: [], clientUserMessageId: "fixture", attachments: [], canSteer: true } };
      },
    });
    const { onError, onOptimisticUserMessageStarted } = renderComposer(activeTurnId);
    await userEvent.click(screen.getByRole("button", { name: "Remove annotation 2" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Annotation 1 comment" }), "Which checks ran?");
    const send = async () => {
      if (shortcut) {
        await userEvent.click(screen.getByRole("textbox", { name: "Message composer" }));
        await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
      } else if (endpoint === "queued-inputs") {
        await userEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Queue message" }));
      } else await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    };
    await send();
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "Annotation 1 comment" })).toHaveValue("Which checks ran?");
    await send();
    await waitFor(() => expect(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`)).toHaveLength(2));
    const bodies = await Promise.all(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`).map(requestJson));
    const text = '<response_annotations>\n<annotation1>\nAssistant text: "Both trim checks passed."\nUser annotation: "Which checks ran?"\n</annotation1>\n</response_annotations>';
    for (const body of bodies) expect(body).toEqual({ input: [{ type: "text", text }], clientUserMessageId: expect.any(String) });
    expect(bodies[0].clientUserMessageId).not.toBe(bodies[1].clientUserMessageId);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Annotation 1 comment" })).not.toBeInTheDocument());
    if (endpoint === "input") expect(onOptimisticUserMessageStarted).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });
});
