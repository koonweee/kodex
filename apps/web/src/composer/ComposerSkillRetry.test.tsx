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
  const onOptimisticUserMessageStarted = vi.fn();
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
          ? { payload: {} }
          : { queuedInput: { id: "queue-1", threadId: "thread-1", input: [], clientUserMessageId: "fixture", attachments: [], canSteer: true } };
      },
    });
    const { onError, onOptimisticUserMessageStarted } = renderComposer(activeTurnId);
    const composer = screen.getByRole("textbox", { name: "Message composer" });
    await userEvent.type(composer, "请 $rev");
    expect(await screen.findByRole("option", { name: /review fix/i })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    if (endpoint === "queued-inputs") {
      await userEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Queue message" }));
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    }

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect((composer as HTMLTextAreaElement).value.trim()).toBe("请 $review-fix");
    expect(composer).toBeEnabled();
    if (endpoint === "queued-inputs") {
      await userEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Queue message" }));
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    }

    await waitFor(() => expect(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`)).toHaveLength(2));
    const expectedBody = { input: [
      { type: "text", text: "请 $review-fix", text_elements: [{ byteRange: { start: 4, end: 15 }, placeholder: "$review-fix" }] },
      { type: "skill", name: "review-fix", path: "/skills/review-fix/SKILL.md" },
    ] };
    const bodies = await Promise.all(gateway.callsFor("POST", `/v1/threads/thread-1/${endpoint}`).map(requestJson));
    if (endpoint === "input") {
      for (const body of bodies) expect(body).toEqual({ ...expectedBody, queueIfPending: true, clientUserMessageId: expect.any(String) });
      expect(bodies[0].clientUserMessageId).not.toBe(bodies[1].clientUserMessageId);
      expect(onOptimisticUserMessageStarted).toHaveBeenCalledTimes(2);
      for (const [index, body] of bodies.entries()) expect(onOptimisticUserMessageStarted.mock.calls[index]).toEqual([
        expect.objectContaining({ clientRequestId: body.clientUserMessageId, text: "请 $review-fix", skillMentions: expect.arrayContaining([expect.objectContaining({ name: "review-fix", path: "/skills/review-fix/SKILL.md" })]) }),
      ]);
    } else for (const body of bodies) expect(body).toEqual({ ...expectedBody, clientUserMessageId: expect.any(String) });
    expect(composer).toHaveValue("");
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
  });
});
