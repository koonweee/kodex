import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { mockGateway, requestJson } from "../test/gatewayMock";
import * as inputCapabilities from "../shared/inputCapabilities";
import { ComposerPanel } from "./ComposerPanel";
import { useComposerOrchestration } from "./useComposerOrchestration";

function composer(activeTurnId: string | null) {
  const settings = { model: "native-model", fast: false };
  const onError = vi.fn();
  function TestComposer() {
    const orchestration = useComposerOrchestration({
      activeSelectedTurnId: activeTurnId, canCompose: true, composerSettings: settings,
      draftChatThreadSelected: false, draftThreadProjectId: null, isDraftThreadSelected: false,
      onCreateDraftThread: vi.fn(), onError, onThreadMaterialized: vi.fn(),
      onThreadTurnStartFailed: vi.fn(), onThreadTurnStarted: vi.fn(),
      selectedProjectId: null, selectedThreadId: "chat",
    });
    return <ComposerPanel
      activeSelectedTurnId={activeTurnId} attachmentInputRef={orchestration.attachmentInputRef}
      canCompose composerResetToken={0} composerSettings={settings} composerSettingsError={null}
      queueThreadId="chat" isDraftThreadSelected={false} isDraftComposerTransitioning={false}
      isComposerDragActive={orchestration.isComposerDragActive} isComposerSubmitting={orchestration.isComposerSubmitting}
      isSelectedTimelineReady models={[]} onAttachmentInputChange={orchestration.handleAttachmentInputChange}
      onComposerDragLeave={orchestration.handleComposerDragLeave} onComposerDragOver={orchestration.handleComposerDragOver}
      onComposerDrop={orchestration.handleComposerDrop} onComposerKeyDown={orchestration.handleComposerKeyDown}
      onComposerPaste={orchestration.handleComposerPaste} onComposerSettingsChange={vi.fn()} onImageOpen={vi.fn()}
      onRemovePendingAttachment={orchestration.removePendingAttachment} onStopTurn={orchestration.handleStopTurn}
      onSubmitTurn={orchestration.handleSubmitTurn} pendingAttachments={orchestration.pendingAttachments} selectedThreadPresent
    />;
  }
  render(<QueryClientProvider client={createKodexQueryClient()}><MantineProvider env="test"><TestComposer /></MantineProvider></QueryClientProvider>);
  return onError;
}

const base = "/v1/threads/chat";
const queuedInput = { id: "queued", threadId: "chat", clientUserMessageId: "queued", input: [{ type: "text", text: "Waiting message" }], attachments: [], canSteer: true };
afterEach(() => vi.restoreAllMocks());

describe("composer send now", () => {
  it.each([
    { activeTurnId: null, touch: false },
    { activeTurnId: "active-turn", touch: false },
    { activeTurnId: null, touch: true },
    { activeTurnId: "active-turn", touch: true },
  ])("Cmd+Enter sends a draft immediately (active $activeTurnId, touch $touch)", async ({ activeTurnId, touch }) => {
    vi.spyOn(inputCapabilities, "isTouchInputDevice").mockReturnValue(touch);
    const gateway = mockGateway({
      [`GET ${base}/queued-inputs`]: { queuedInputs: [queuedInput], transfers: [], nextCursor: null },
      [`POST ${base}/input`]: { payload: {} },
    });
    const onError = composer(activeTurnId);
    await screen.findByText("Waiting message", { exact: true });
    const field = screen.getByRole("textbox", { name: "Message composer" });
    await userEvent.type(field, "Act on this now");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(gateway.callsFor("POST", `${base}/input`)).toHaveLength(1));
    expect(await requestJson(gateway.callsFor("POST", `${base}/input`)[0])).toEqual({
      input: [{ type: "text", text: "Act on this now" }], clientUserMessageId: expect.any(String),
    });
    expect(gateway.callsFor("POST", `${base}/queued-inputs`)).toHaveLength(0);
    expect(screen.getByText("Waiting message", { exact: true })).toBeVisible();
    expect(field).toHaveValue("");
    expect(onError).not.toHaveBeenCalled();
  });

  it("retains touch Enter as newline before a Cmd+Enter send-now", async () => {
    vi.spyOn(inputCapabilities, "isTouchInputDevice").mockReturnValue(true);
    const gateway = mockGateway({
      [`GET ${base}/queued-inputs`]: { queuedInputs: [queuedInput], transfers: [], nextCursor: null },
      [`POST ${base}/input`]: { payload: {} },
    });
    composer(null);
    const field = screen.getByRole("textbox", { name: "Message composer" });
    await userEvent.type(field, "First line{Enter}Second line");
    expect(field).toHaveValue("First line\nSecond line");
    expect(gateway.calls.filter(request => request.method === "POST")).toHaveLength(0);
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(gateway.callsFor("POST", `${base}/input`)).toHaveLength(1));
    expect(await requestJson(gateway.callsFor("POST", `${base}/input`)[0])).toEqual({
      input: [{ type: "text", text: "First line\nSecond line" }], clientUserMessageId: expect.any(String),
    });
  });

  it.each(["Enter", "Send"])("ordinary %s retains queue-first submission", async (gesture) => {
    const gateway = mockGateway({
      [`GET ${base}/queued-inputs`]: { queuedInputs: [queuedInput], transfers: [], nextCursor: null },
      [`POST ${base}/input`]: { payload: {}, disposition: "queued" },
    });
    composer(null);
    await screen.findByText("Waiting message", { exact: true });
    await userEvent.type(screen.getByRole("textbox", { name: "Message composer" }), "Join the queue");
    if (gesture === "Enter") await userEvent.keyboard("{Enter}");
    else await userEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(gateway.callsFor("POST", `${base}/input`)).toHaveLength(1));
    expect(await requestJson(gateway.callsFor("POST", `${base}/input`)[0])).toEqual({
      queueIfPending: true, input: [{ type: "text", text: "Join the queue" }], clientUserMessageId: expect.any(String),
    });
  });

  it.each([{ shiftKey: true }, { isComposing: true }])("preserves modified or composing Cmd+Enter: %o", async (keys) => {
    const gateway = mockGateway({ [`GET ${base}/queued-inputs`]: { queuedInputs: [queuedInput], transfers: [], nextCursor: null } });
    composer(null);
    await userEvent.type(screen.getByRole("textbox", { name: "Message composer" }), "Unsent draft");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message composer" }), { key: "Enter", metaKey: true, ...keys });
    expect(gateway.calls.filter(request => request.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("Unsent draft");
  });
});
