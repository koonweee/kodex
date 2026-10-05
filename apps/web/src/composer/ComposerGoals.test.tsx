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

  it.each([false, true])("keeps a paused goal accessible through the narrow icon (touch=%s)", async (touch) => {
    window.matchMedia = (query) => ({ ...originalMatchMedia(query), matches: query === "(max-width: 900px)" || (touch && query.includes("coarse")) });
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
});
