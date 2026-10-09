import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearThreadGoal, getThreadGoal, updateThreadGoal, type ThreadGoal } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { ComposerPanel } from "./ComposerPanel";

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<typeof import("../api/client")>()),
  getThreadGoal: vi.fn(), updateThreadGoal: vi.fn(), clearThreadGoal: vi.fn(),
}));

const paneLayout = vi.hoisted(() => ({ compact: false, short: false }));
vi.mock("../shared/PaneLayout", () => ({ usePaneLayout: () => paneLayout }));

const goal: ThreadGoal = {
  threadId: "thread-1", objective: "Finish the dashboard", status: "active",
  tokenBudget: 20000, tokensUsed: 4000, timeUsedSeconds: 90, createdAt: 1, updatedAt: 2,
};

function composer(props: Partial<ComponentProps<typeof ComposerPanel>> = {}) {
  const client = createKodexQueryClient();
  const node = (overrides: Partial<ComponentProps<typeof ComposerPanel>>) => <QueryClientProvider client={client}><MantineProvider><ComposerPanel
    activeSelectedTurnId={null} attachmentInputRef={{ current: null }} canCompose composerResetToken={0}
    composerSettings={{ model: "gpt-5.4", fast: false }} composerSettingsError={null}
    goalThreadId="thread-1" isDraftThreadSelected={false} isDraftComposerTransitioning={false}
    isComposerDragActive={false} isComposerSubmitting={false} isSelectedTimelineReady models={[]}
    onAttachmentInputChange={vi.fn()} onComposerDragLeave={vi.fn()} onComposerDragOver={vi.fn()} onComposerDrop={vi.fn()}
    onComposerKeyDown={vi.fn()} onComposerPaste={vi.fn()} onComposerSettingsChange={vi.fn()} onImageOpen={vi.fn()}
    onRemovePendingAttachment={vi.fn()} onStopTurn={vi.fn()} onSubmitTurn={(event) => event.preventDefault()}
    pendingAttachments={[]} selectedThreadPresent {...overrides}
  /></MantineProvider></QueryClientProvider>;
  const rendered = render(node(props));
  return { ...rendered, changeProps: (overrides: Partial<ComponentProps<typeof ComposerPanel>>) => rendered.rerender(node({ ...props, ...overrides })) };
}

const originalMatchMedia = window.matchMedia;

describe("composer goals", () => {
  beforeEach(() => {
    paneLayout.compact = false;
    vi.mocked(getThreadGoal).mockReset().mockResolvedValue({ goal });
    vi.mocked(updateThreadGoal).mockReset().mockResolvedValue({ goal });
    vi.mocked(clearThreadGoal).mockReset().mockResolvedValue({ cleared: true });
  });
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  it("shows the desktop objective and opens management without submitting the message", async () => {
    composer();
    expect(await screen.findByRole("region", { name: "Chat goal" })).toHaveTextContent("Finish the dashboard");
    await userEvent.click(screen.getByRole("button", { name: "Manage goal: Active" }));
    expect(screen.getByRole("dialog", { name: "Goal" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue(goal.objective);
    await userEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(clearThreadGoal).toHaveBeenCalledWith("thread-1");
  });

  it("does not leave the goal portal visible after its pane becomes inactive", async () => {
    const rendered = composer();
    await userEvent.click(await screen.findByRole("button", { name: "Manage goal: Active" }));
    expect(screen.getByRole("dialog", { name: "Goal" })).toBeInTheDocument();

    rendered.changeProps({ paneActive: false });
    expect(screen.queryByRole("dialog", { name: "Goal" })).not.toBeInTheDocument();
  });

  it("deletes a completed goal directly from the bar and refills native state", async () => {
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: { ...goal, status: "complete" } });
    const onSubmitTurn = vi.fn();
    composer({ onSubmitTurn });
    const remove = await screen.findByRole("button", { name: "Delete goal" });
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: null });
    await userEvent.click(remove);
    await waitFor(() => expect(clearThreadGoal).toHaveBeenCalledWith("thread-1"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Chat goal" })).not.toBeInTheDocument());
    expect(onSubmitTurn).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a paused goal accessible through the narrow icon (touch=%s)", async (touch) => {
    paneLayout.compact = true;
    window.matchMedia = (query) => ({ ...originalMatchMedia(query), matches: touch && query.includes("coarse") });
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: { ...goal, status: "paused" } });
    composer();
    await screen.findByRole("button", { name: "Manage goal: Paused" });
    expect(screen.queryByRole("region", { name: "Chat goal" })).not.toBeInTheDocument();
    expect(screen.queryByText(goal.objective)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Manage goal: Paused" }));
    expect(screen.getByRole("dialog", { name: "Goal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume goal" })).toBeInTheDocument();
  });

  it("creates a goal for an existing chat from the plus menu", async () => {
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: null });
    composer();
    await waitFor(() => expect(getThreadGoal).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Set goal" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "Ship it" } });
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    expect(updateThreadGoal).toHaveBeenCalledWith("thread-1", { objective: "Ship it" });
  });

  it("keeps the next chat editor open when an earlier chat save completes", async () => {
    let resolveUpdate!: (value: { goal: ThreadGoal }) => void;
    vi.mocked(updateThreadGoal).mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    vi.mocked(getThreadGoal).mockImplementation(async (threadId) => ({ goal: { ...goal, threadId, objective: `Goal for ${threadId}` } }));
    const rendered = composer();
    await userEvent.click(await screen.findByRole("button", { name: "Manage goal: Active" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "First chat edit" } });
    await userEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(updateThreadGoal).toHaveBeenCalled());
    rendered.changeProps({ goalThreadId: "thread-2" });
    await userEvent.click(await screen.findByRole("button", { name: "Manage goal: Active" }));
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("Goal for thread-2");
    await act(async () => { resolveUpdate({ goal: { ...goal, objective: "First chat edit" } }); });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Goal" })).toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue("Goal for thread-2");
  });

  it("omits goal creation and reads for an unmaterialized draft", async () => {
    composer({ goalThreadId: null, isDraftThreadSelected: true, selectedThreadPresent: false });
    expect(getThreadGoal).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
    expect(screen.queryByRole("menuitem", { name: "Set goal" })).not.toBeInTheDocument();
  });

  it("sets an active goal directly from /goal without submitting model input", async () => {
    const onSubmitTurn = vi.fn();
    composer({ onSubmitTurn });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "/goal Ship the dashboard\nwith tests" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(updateThreadGoal).toHaveBeenCalledWith("thread-1", {
      objective: "Ship the dashboard\nwith tests", status: "active",
    }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(onSubmitTurn).not.toHaveBeenCalled();
  });

  it("opens goal management for bare /goal without changing native state", async () => {
    const onSubmitTurn = vi.fn();
    composer({ onSubmitTurn });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: " /goal " } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("dialog", { name: "Goal" })).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(updateThreadGoal).not.toHaveBeenCalled();
    expect(onSubmitTurn).not.toHaveBeenCalled();
  });

  it("preserves a failed /goal draft and permits retry", async () => {
    vi.mocked(updateThreadGoal).mockRejectedValueOnce(new Error("Goal unavailable"));
    composer();
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "/goal Ship it" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Goal unavailable");
    expect(input).toHaveValue("/goal Ship it");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(updateThreadGoal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it.each(["attachment", "annotation"])("rejects /goal with a %s and preserves its draft", async (kind) => {
    const draftStore = new Map([["thread-1", { composerText: "/goal Ship it", skillBindings: [],
      annotations: kind === "annotation" ? [{ id: "annotation-1", text: "Quoted answer", comment: "Revise" }] : [] }]]);
    const onSubmitTurn = vi.fn();
    composer({ composerDraftKey: "thread-1", composerDraftStore: draftStore, onSubmitTurn,
      pendingAttachments: kind === "attachment" ? [{ id: "file-1", kind: "file", status: "pending", file: new File(["x"], "notes.txt") }] : [] });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/\/goal does not support attachments, annotations, or skill mentions/i);
    expect(input).toHaveValue("/goal Ship it");
    expect(updateThreadGoal).not.toHaveBeenCalled();
    expect(onSubmitTurn).not.toHaveBeenCalled();
    expect(draftStore.get("thread-1")?.annotations?.length).toBe(kind === "annotation" ? 1 : 0);
  });

  it("rejects /goal in an unmaterialized draft without starting a chat", async () => {
    const onSubmitTurn = vi.fn();
    composer({ goalThreadId: null, isDraftThreadSelected: true, selectedThreadPresent: false, onSubmitTurn });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "/goal Ship it" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("/goal is only available in an existing chat");
    expect(input).toHaveValue("/goal Ship it");
    expect(onSubmitTurn).not.toHaveBeenCalled();
    expect(updateThreadGoal).not.toHaveBeenCalled();
  });

  it("does not clear another chat draft when a goal command completes", async () => {
    let resolveUpdate!: (value: { goal: ThreadGoal }) => void;
    vi.mocked(updateThreadGoal).mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    const draftStore = new Map([["thread-2", { composerText: "Second chat draft", skillBindings: [] }]]);
    const rendered = composer({ composerDraftKey: "thread-1", composerDraftStore: draftStore });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "/goal First goal" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(updateThreadGoal).toHaveBeenCalled());
    rendered.changeProps({ goalThreadId: "thread-2", composerDraftKey: "thread-2" });
    expect(input).toHaveValue("Second chat draft");
    await act(async () => { resolveUpdate({ goal }); });
    expect(input).toHaveValue("Second chat draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects queueing a goal command without mutating or losing its text", async () => {
    const onSubmitTurn = vi.fn();
    composer({ onSubmitTurn });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "/goal Ship it" } });
    await userEvent.click(screen.getByRole("button", { name: "Open attachment menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Queue message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("/goal cannot be queued");
    expect(input).toHaveValue("/goal Ship it");
    expect(updateThreadGoal).not.toHaveBeenCalled();
    expect(onSubmitTurn).not.toHaveBeenCalled();
  });

  it("keeps ordinary text mentioning /goal on the normal submit path", () => {
    const onSubmitTurn = vi.fn();
    composer({ onSubmitTurn });
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "Explain /goal Ship it" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSubmitTurn).toHaveBeenCalled();
    expect(updateThreadGoal).not.toHaveBeenCalled();
  });

  it("offers /goal in slash suggestions and inserts it without starting work", async () => {
    composer();
    const input = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.change(input, { target: { value: "/go", selectionStart: 3, selectionEnd: 3 } });
    await userEvent.click(await screen.findByRole("option", { name: /goal/i }));
    expect(input).toHaveValue("/goal ");
    expect(updateThreadGoal).not.toHaveBeenCalled();
  });
});
