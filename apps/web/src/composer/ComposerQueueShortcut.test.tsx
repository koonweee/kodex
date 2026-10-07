import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { mockGateway } from "../test/gatewayMock";
import { ComposerPanel } from "./ComposerPanel";

const base = "/v1/threads/chat/queued-inputs";
const row = (id: string) => ({ id, threadId: "chat", clientUserMessageId: id, input: [{ type: "text", text: id }], attachments: [], canSteer: true });
function composer(props: Partial<ComponentProps<typeof ComposerPanel>> = {}) {
  const fallback = vi.fn();
  render(<QueryClientProvider client={createKodexQueryClient()}><MantineProvider env="test"><ComposerPanel
    activeSelectedTurnId="turn" attachmentInputRef={{ current: null }} canCompose composerResetToken={0}
    composerSettings={{ model: "test", fast: false }} composerSettingsError={null}
    queueThreadId="chat" isDraftThreadSelected={false} isDraftComposerTransitioning={false}
    isComposerDragActive={false} isComposerSubmitting={false} isSelectedTimelineReady models={[]}
    onAttachmentInputChange={vi.fn()} onComposerDragLeave={vi.fn()} onComposerDragOver={vi.fn()} onComposerDrop={vi.fn()}
    onComposerKeyDown={fallback} onComposerPaste={vi.fn()} onComposerSettingsChange={vi.fn()} onImageOpen={vi.fn()}
    onRemovePendingAttachment={vi.fn()} onStopTurn={vi.fn()} onSubmitTurn={(event) => event.preventDefault()}
    pendingAttachments={[]} selectedThreadPresent {...props}
  /></MantineProvider></QueryClientProvider>);
  return fallback;
}
const shortcut = (init = {}) => fireEvent.keyDown(screen.getByRole("textbox", { name: "Message composer" }), { key: "Enter", metaKey: true, ...init });

describe("empty composer queue shortcut", () => {
  it.each([null, "turn"])("delegates send now and current first-row selection to the gateway (active turn %s)", async (activeSelectedTurnId) => {
    let rows = [row("a"), row("b")];
    const gateway = mockGateway({
      [`GET ${base}`]: () => ({ queuedInputs: rows, transfers: [], nextCursor: null }),
      [`POST ${base}/steer-first`]: () => { rows = [row("a")]; return { status: "delivered", id: "promotion-b" }; },
    });
    const fallback = composer({ activeSelectedTurnId });
    await screen.findByText("b", { exact: true });
    // This tab misses another client's reorder. No cached ID may be submitted.
    rows.reverse();
    shortcut();
    await waitFor(() => expect(gateway.callsFor("POST", `${base}/steer-first`)).toHaveLength(1));
    expect(fallback).not.toHaveBeenCalled();
    expect(await gateway.callsFor("POST", `${base}/steer-first`)[0].text()).toBe("");
    await waitFor(() => expect(screen.queryByText("b", { exact: true })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("");
  });

  it.each(["text", "annotation", "attachment", "submitting", "unready", "read-only"])("does not send queued input when composer has %s", async (kind) => {
    const gateway = mockGateway({ [`GET ${base}`]: { queuedInputs: [row("a")], transfers: [], nextCursor: null } });
    const props: Partial<ComponentProps<typeof ComposerPanel>> = kind === "annotation" ? {
      composerDraftKey: "draft", composerDraftStore: new Map([["draft", { composerText: "", skillBindings: [], annotations: [{ id: "quote", text: "Selected text", comment: "" }] }]]),
    } : kind === "attachment" ? { pendingAttachments: [{ id: "file", kind: "file", file: new File(["draft"], "draft.txt"), status: "pending" }] }
      : kind === "submitting" ? { isComposerSubmitting: true } : kind === "unready" ? { isSelectedTimelineReady: false }
        : kind === "read-only" ? { canCompose: false } : {};
    const fallback = composer(props);
    await screen.findByText("a", { exact: true });
    if (kind === "text") fireEvent.change(screen.getByRole("textbox", { name: "Message composer" }), { target: { value: "New input" } });
    shortcut();
    expect(gateway.calls.filter((request) => request.method === "POST")).toHaveLength(0);
    if (["text", "annotation", "attachment"].includes(kind)) expect(fallback).toHaveBeenCalledOnce();
  });

  it.each([{ shiftKey: true }, { isComposing: true }, { metaKey: false }])("leaves other Enter/composition gestures to the composer: %o", async (keys) => {
    const gateway = mockGateway({ [`GET ${base}`]: { queuedInputs: [row("a")], transfers: [], nextCursor: null } });
    const fallback = composer();
    await screen.findByText("a", { exact: true });
    shortcut(keys);
    expect(gateway.callsFor("POST", `${base}/steer-first`)).toHaveLength(0);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does nothing with an empty queue", async () => {
    const gateway = mockGateway({ [`GET ${base}`]: { queuedInputs: [], transfers: [], nextCursor: null } });
    const fallback = composer();
    await waitFor(() => expect(gateway.callsFor("GET", base)).toHaveLength(1));
    shortcut();
    expect(gateway.callsFor("POST", `${base}/steer-first`)).toHaveLength(0);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("blocks repeated shortcuts while pending and keeps failed input queued without retry", async () => {
    let reject!: (value: Response) => void;
    const gateway = mockGateway({
      [`GET ${base}`]: { queuedInputs: [row("a")], transfers: [], nextCursor: null },
      [`POST ${base}/steer-first`]: () => new Promise<Response>(resolve => { reject = resolve; }),
    });
    composer();
    await screen.findByText("a", { exact: true });
    shortcut(); shortcut();
    await waitFor(() => expect(gateway.callsFor("POST", `${base}/steer-first`)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Steer" })).toBeDisabled();
    reject(new Response(JSON.stringify({ code: "conflict", message: "Original turn has ended", retryable: false }), { status: 409, headers: { "content-type": "application/json" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Original turn has ended");
    await waitFor(() => expect(screen.getByRole("button", { name: "Steer" })).toBeEnabled());
    expect(screen.getByText("a", { exact: true })).toBeVisible();
    expect(gateway.callsFor("POST", `${base}/steer-first`)).toHaveLength(1);
  });
});
