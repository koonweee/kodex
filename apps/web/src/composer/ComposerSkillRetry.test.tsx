import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import type { SkillMetadata } from "../api/client";
import { mockGateway, requestJson } from "../test/gatewayMock";
import { ComposerPanel } from "./ComposerPanel";
import { useComposerOrchestration } from "./useComposerOrchestration";

const selectedSkill: SkillMetadata = {
  description: "Review and fix changes",
  enabled: true,
  interface: { displayName: "Review Fix", shortDescription: "Review loop", brandColor: "#23a55a" },
  name: "review-fix",
  path: "/skills/review-fix/SKILL.md",
  scope: "user",
};

function renderComposer(activeTurnId: string | null) {
  const onError = vi.fn();
  const onOptimisticUserMessageStarted = vi.fn(() => "local-pending");
  const settings = { model: "native-model", fast: false };
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
      onQueuedInputDeleted: vi.fn(),
      onQueuedInputUpsert: vi.fn(),
      onThreadMaterialized: vi.fn(),
      onThreadTurnStartFailed: vi.fn(),
      onThreadTurnStarted: vi.fn(),
      queuedSteerRows: [],
      selectedProjectId: null,
      selectedThreadId: "thread-1",
    });
    return <ComposerPanel
      activeSelectedTurnId={activeTurnId}
      attachmentInputRef={orchestration.attachmentInputRef}
      canCompose
      composerCwd="/workspace"
      composerDraftKey="pane:one:thread:thread-1"
      composerResetToken={0}
      composerSettings={settings}
      composerSettingsError={null}
      isDraftThreadSelected={false}
      isDraftComposerTransitioning={false}
      isComposerDragActive={orchestration.isComposerDragActive}
      isComposerSubmitting={orchestration.isComposerSubmitting}
      isSelectedTimelineReady
      models={[]}
      onAbortQueuedSteer={orchestration.handleAbortQueuedSteer}
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
      onSubmitQueuedSteer={orchestration.handleSubmitQueuedSteer}
      onSubmitTurn={orchestration.handleSubmitTurn}
      pendingAttachments={orchestration.pendingAttachments}
      queuedSteerRows={[]}
      selectedThreadPresent
    />;
  }
  render(<QueryClientProvider client={createKodexQueryClient()}><MantineProvider env="test"><RetryComposer /></MantineProvider></QueryClientProvider>);
  return { onError, onOptimisticUserMessageStarted };
}

describe("explicit skill retry", () => {
  it.each([
    { activeTurnId: null, endpoint: "input" },
    { activeTurnId: "active-turn", endpoint: "queued-inputs" },
  ])("retains the selected skill and UTF-8 spans after a rejected $endpoint request", async ({ activeTurnId, endpoint }) => {
    let attempts = 0;
    const gateway = mockGateway({
      "GET /v1/skills": { cwd: "/workspace", errors: [], invalidationGeneration: 0, skills: [selectedSkill] },
      [`POST /v1/threads/thread-1/${endpoint}`]: () => {
        if (++attempts === 1) {
          return new Response(JSON.stringify({ code: "rejected", message: "Native input rejected", retryable: false }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }
        return endpoint === "input"
          ? { disposition: "started", queuedInput: null, rawPayload: {} }
          : { queuedInput: { id: "queue-1", threadId: "thread-1", input: [], options: {}, status: "queued", priority: "normal", attemptCount: 0, lastError: null, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" } };
      },
    });
    const { onError, onOptimisticUserMessageStarted } = renderComposer(activeTurnId);
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    await userEvent.type(composer, "请 $rev");
    expect(await screen.findByRole("option", { name: /review fix/i })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect((composer as HTMLTextAreaElement).value.trim()).toBe("请 $review-fix");
    expect(composer).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`)).toHaveLength(2));
    const expectedBody = { input: [
      { type: "text", text: "请 $review-fix", text_elements: [{ byteRange: { start: 4, end: 15 }, placeholder: "$review-fix" }] },
      { type: "skill", name: "review-fix", path: "/skills/review-fix/SKILL.md" },
    ] };
    for (const request of gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`)) {
      await expect(requestJson(request)).resolves.toEqual(expectedBody);
    }
    if (endpoint === "input") {
      expect(onOptimisticUserMessageStarted).toHaveBeenCalledTimes(2);
      expect(onOptimisticUserMessageStarted.mock.calls[1]).toEqual(onOptimisticUserMessageStarted.mock.calls[0]);
    }
    expect(composer).toHaveValue("");
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
  });
});
