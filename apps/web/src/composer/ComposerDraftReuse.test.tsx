import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComposerPanel } from "./ComposerPanel";

describe("draft composer reuse eligibility", () => {
  function composer(overrides: Partial<ComponentProps<typeof ComposerPanel>> = {}) {
    const onDraftDisposableChange = vi.fn();
    const noop = () => undefined;
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider><ComposerPanel
        activeSelectedTurnId={null} attachmentInputRef={{ current: null }} canCompose
        composerResetToken={0} composerSettings={{ fast: false, model: "test-model" }} composerSettingsError={null}
        isDraftThreadSelected isDraftComposerTransitioning={false} isComposerDragActive={false}
        isComposerSubmitting={false} isSelectedTimelineReady models={[]}
        onAttachmentInputChange={noop} onComposerDragLeave={noop} onComposerDragOver={noop}
        onComposerDrop={noop} onComposerKeyDown={noop} onComposerPaste={noop}
        onComposerSettingsChange={noop} onImageOpen={noop} onRemovePendingAttachment={noop}
        onStopTurn={noop} onSubmitTurn={noop} pendingAttachments={[]} selectedThreadPresent={false}
        onDraftDisposableChange={onDraftDisposableChange} {...overrides}
      /></MantineProvider>
    </QueryClientProvider>);
    return onDraftDisposableChange;
  }

  it("allows an empty composer and allows reuse again after clearing typed text", () => {
    const report = composer();
    expect(report).toHaveBeenLastCalledWith(true);
    const input = screen.getByRole("textbox", { name: /message composer/i });
    fireEvent.change(input, { target: { value: " " } });
    expect(report).toHaveBeenLastCalledWith(false);
    fireEvent.change(input, { target: { value: "" } });
    expect(report).toHaveBeenLastCalledWith(true);
  });

  it.each(["pending", "uploading", "uploaded", "error"] as const)("protects %s attachments with no text", (status) => {
    const report = composer({ pendingAttachments: [{ id: "file", kind: "file", file: new File(["draft"], "draft.txt"), status }] });
    expect(report).toHaveBeenLastCalledWith(false);
  });

  it("protects annotation-only content", () => {
    const report = composer({ composerDraftKey: "draft", composerDraftStore: new Map([["draft", {
      composerText: "", skillBindings: [], annotations: [{ id: "annotation", text: "Selected answer", comment: "" }],
    }]]) });
    expect(report).toHaveBeenLastCalledWith(false);
  });

  it.each(["isComposerSubmitting", "isDraftComposerTransitioning"] as const)("protects %s even after clearing input", (busy) => {
    const report = composer({ [busy]: true });
    expect(report).toHaveBeenLastCalledWith(false);
  });
});
