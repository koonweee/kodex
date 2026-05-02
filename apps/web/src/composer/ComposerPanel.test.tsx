import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useRef, useState, type FormEvent, type RefObject } from "react";

import type { ComposerSettings } from "../ComposerFooterControls";
import { ComposerPanel, type ComposerDraftControls } from "./ComposerPanel";

const composerSettings: ComposerSettings = {
  effort: "medium",
  fast: false,
  model: "gpt-5.4",
  permissionPreset: "default",
};

function noopSubmit(event: FormEvent) {
  event.preventDefault();
}

describe("ComposerPanel", () => {
  it("keeps draft typing local until submit", async () => {
    const submittedDrafts: string[] = [];
    let parentRenderCount = 0;

    function Harness() {
      parentRenderCount += 1;
      const attachmentInputRef = useRef<HTMLInputElement | null>(null);
      const [submitCount, setSubmitCount] = useState(0);

      function handleSubmit(
        event: FormEvent,
        draftText: string,
        controls: ComposerDraftControls,
      ) {
        event.preventDefault();
        submittedDrafts.push(draftText);
        setSubmitCount((current) => current + 1);
        controls.clearText();
      }

      return (
        <MantineProvider>
          <div data-testid="submit-count">{submitCount}</div>
          <ComposerPanel
            activeSelectedTurnId={null}
            attachmentInputRef={attachmentInputRef}
            canCompose
            composerResetToken={0}
            composerSettings={composerSettings}
            composerSettingsError={null}
            contextUsage={null}
            isDraftThreadSelected={false}
            isDraftComposerTransitioning={false}
            isComposerDragActive={false}
            isComposerSubmitting={false}
            isSelectedTimelineReady
            models={[]}
            onAbortQueuedSteer={vi.fn()}
            onAttachmentInputChange={vi.fn()}
            onComposerDragLeave={vi.fn()}
            onComposerDragOver={vi.fn()}
            onComposerDrop={vi.fn()}
            onComposerKeyDown={vi.fn()}
            onComposerPaste={vi.fn()}
            onComposerSettingsChange={vi.fn()}
            onImageOpen={vi.fn()}
            onRemovePendingAttachment={vi.fn()}
            onStopTurn={vi.fn()}
            onSubmitQueuedSteer={vi.fn()}
            onSubmitTurn={handleSubmit}
            pendingAttachments={[]}
            queuedSteerRows={[]}
            selectedThreadPresent
          />
        </MantineProvider>
      );
    }

    render(<Harness />);

    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Keep this local");

    expect(parentRenderCount).toBe(1);
    expect(screen.getByRole("button", { name: /send message/i })).toBeEnabled();
    expect(submittedDrafts).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(submittedDrafts).toEqual(["Keep this local"]);
    expect(screen.getByTestId("submit-count")).toHaveTextContent("1");
    expect(composer).toHaveValue("");
  });

  it("resets the local draft when the shell asks it to clear", async () => {
    const attachmentInputRef = { current: null } as RefObject<HTMLInputElement | null>;
    const { rerender } = render(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={0}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          isDraftThreadSelected={false}
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
          onAbortQueuedSteer={vi.fn()}
          onAttachmentInputChange={vi.fn()}
          onComposerDragLeave={vi.fn()}
          onComposerDragOver={vi.fn()}
          onComposerDrop={vi.fn()}
          onComposerKeyDown={vi.fn()}
          onComposerPaste={vi.fn()}
          onComposerSettingsChange={vi.fn()}
          onImageOpen={vi.fn()}
          onRemovePendingAttachment={vi.fn()}
          onStopTurn={vi.fn()}
          onSubmitQueuedSteer={vi.fn()}
          onSubmitTurn={noopSubmit}
          pendingAttachments={[]}
          queuedSteerRows={[]}
          selectedThreadPresent
        />
      </MantineProvider>,
    );

    await userEvent.type(screen.getByLabelText(/message composer/i), "Draft");
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Draft");

    rerender(
      <MantineProvider>
        <ComposerPanel
          activeSelectedTurnId={null}
          attachmentInputRef={attachmentInputRef}
          canCompose
          composerResetToken={1}
          composerSettings={composerSettings}
          composerSettingsError={null}
          contextUsage={null}
          isDraftThreadSelected={false}
          isDraftComposerTransitioning={false}
          isComposerDragActive={false}
          isComposerSubmitting={false}
          isSelectedTimelineReady
          models={[]}
          onAbortQueuedSteer={vi.fn()}
          onAttachmentInputChange={vi.fn()}
          onComposerDragLeave={vi.fn()}
          onComposerDragOver={vi.fn()}
          onComposerDrop={vi.fn()}
          onComposerKeyDown={vi.fn()}
          onComposerPaste={vi.fn()}
          onComposerSettingsChange={vi.fn()}
          onImageOpen={vi.fn()}
          onRemovePendingAttachment={vi.fn()}
          onStopTurn={vi.fn()}
          onSubmitQueuedSteer={vi.fn()}
          onSubmitTurn={noopSubmit}
          pendingAttachments={[]}
          queuedSteerRows={[]}
          selectedThreadPresent
        />
      </MantineProvider>,
    );

    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
  });
});
