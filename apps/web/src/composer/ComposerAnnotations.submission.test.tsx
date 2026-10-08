import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { mockGateway, requestJson } from "../test/gatewayMock";
import { ComposerPanel } from "./ComposerPanel";
import { useComposerOrchestration } from "./useComposerOrchestration";

function renderComposer(activeTurnId: string | null) {
  const onError = vi.fn();
  const onOptimisticUserMessageStarted = vi.fn();
  const onOptimisticUserMessageRemoved = vi.fn();
  const onOptimisticUserMessageSent = vi.fn();
  const onThreadTurnStarted = vi.fn();
  const onThreadTurnStartFailed = vi.fn();
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
      onOptimisticUserMessageRemoved,
      onOptimisticUserMessageSent,
      onThreadMaterialized: vi.fn(),
      onThreadTurnStartFailed,
      onThreadTurnStarted,
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
  return { onError, onOptimisticUserMessageStarted, onOptimisticUserMessageRemoved, onOptimisticUserMessageSent, onThreadTurnStarted, onThreadTurnStartFailed };
}

describe("annotation submissions", () => {
  it("does not mark an existing active turn idle when composer submission fails", async () => {
    mockGateway({ "POST /v1/threads/thread-1/input": () => new Response(JSON.stringify({ code: "conflict", message: "Queue unavailable", retryable: false }), { status: 409, headers: { "content-type": "application/json" } }) });
    const callbacks = renderComposer("active-turn");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(callbacks.onError).toHaveBeenCalled());
    expect(callbacks.onThreadTurnStarted).not.toHaveBeenCalled();
    expect(callbacks.onThreadTurnStartFailed).not.toHaveBeenCalled();
    expect(await screen.findByRole("textbox", { name: "Annotation 1 comment" })).toBeVisible();
  });

  it("removes the optimistic transcript row when normal Send is authoritatively queued", async () => {
    mockGateway({ "POST /v1/threads/thread-1/input": { payload: {}, disposition: "queued" } });
    const callbacks = renderComposer("active-turn");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(callbacks.onOptimisticUserMessageRemoved).toHaveBeenCalledOnce());
    const submitted = callbacks.onOptimisticUserMessageStarted.mock.calls[0][0];
    expect(callbacks.onOptimisticUserMessageRemoved).toHaveBeenCalledWith(submitted.clientRequestId);
    expect(callbacks.onOptimisticUserMessageSent).not.toHaveBeenCalled();
    expect(callbacks.onThreadTurnStarted).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Annotation 1 comment" })).not.toBeInTheDocument();
  });

  it.each([null, "active-turn"])("submits from an annotation with Enter and preserves Shift+Enter and IME input (active %s)", async (activeTurnId) => {
    const gateway = mockGateway({ "POST /v1/threads/thread-1/input": () => ({ payload: {} }) });
    renderComposer(activeTurnId);
    await userEvent.type(screen.getByRole("textbox", { name: "Message composer" }), "Review these.");
    const comment = screen.getByRole("textbox", { name: "Annotation 1 comment" });
    await userEvent.type(comment, "Which checks ran?");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}Show commands.");
    expect(comment).toHaveValue("Which checks ran?\nShow commands.");
    fireEvent.keyDown(comment, { key: "Enter", isComposing: true });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1));
    const body = await requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0]);
    expect(body).toEqual({ queueIfPending: true, input: [{ type: "text", text: [
      "Review these.", "", "<response_annotations>", "<annotation1>",
      'Assistant text: "Both trim checks passed."',
      'User annotation: "Which checks ran?\\nShow commands."',
      "</annotation1>", "<annotation2>", 'Assistant text: "Cache cleared."',
      'User annotation: "Keep this?"', "</annotation2>", "</response_annotations>",
    ].join("\n") }], clientUserMessageId: expect.any(String) });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Annotation 1 comment" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("");
  });

  it.each([
    { activeTurnId: null, endpoint: "input" },
    { activeTurnId: "active-turn", endpoint: "queued-inputs" },
    { activeTurnId: "active-turn", endpoint: "input", shortcut: true },
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
        await userEvent.click(screen.getByRole("textbox", { name: "Annotation 1 comment" }));
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
    for (const body of bodies) expect(body).toEqual({ ...(endpoint === "input" ? shortcut ? { queueIfEmpty: true } : { queueIfPending: true } : {}), input: [{ type: "text", text }], clientUserMessageId: expect.any(String) });
    expect(bodies[0].clientUserMessageId).not.toBe(bodies[1].clientUserMessageId);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Annotation 1 comment" })).not.toBeInTheDocument());
    if (endpoint === "input") expect(onOptimisticUserMessageStarted).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });
});
