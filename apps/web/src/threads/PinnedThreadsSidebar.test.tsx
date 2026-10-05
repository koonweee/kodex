import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../api/client";
import { PinnedThreadsSidebar } from "./PinnedThreadsSidebar";

const first: ThreadSummary = { parentThreadId: null, canAcceptDirectInput: null, id: "first", name: "First", pinned: true, projectId: "project", cwd: "/repo", createdAt: 1, updatedAt: 1, status: "idle", notificationsEnabled: true, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, rawPayload: {} };
const second = { ...first, id: "second", name: "Second", status: "active" as const, updatedAt: 100 };
const third = { ...first, id: "third", name: "Third" };
function mount(overrides: Partial<ComponentProps<typeof PinnedThreadsSidebar>> = {}) {
  const onMovePinnedThread = vi.fn();
  render(<MantineProvider env="test"><PinnedThreadsSidebar threads={[first, second, third]} collapsed={false} onToggle={vi.fn()} searchQuery="" approvals={[]} hoveredThreadActionId={null} onArchiveThread={vi.fn()} onPinThread={vi.fn()} onUnpinThread={vi.fn()} onSelectThread={vi.fn()} onThreadActionHoverChange={vi.fn()} pendingTitleThreadIds={new Set()} selectedThreadId={null} onMovePinnedThread={onMovePinnedThread} {...overrides} /></MantineProvider>);
  return onMovePinnedThread;
}

describe("Pinned native order", () => {
  it("retains native row order and sends relative move intents without changing local membership", async () => {
    const move = mount();
    const group = within(screen.getByRole("group", { name: "Pinned" }));
    expect(group.getAllByRole("button", { name: /^(First|Second|Third)$/ }).map((row) => row.textContent)).toEqual(["First", "Second", "Third"]);
    fireEvent.pointerDown(group.getByRole("button", { name: "Thread actions for Second" }), { pointerType: "touch" });
    await userEvent.click(group.getByRole("button", { name: "Thread actions for Second" }));
    expect(screen.queryByText("Move to section")).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
    expect(move).toHaveBeenLastCalledWith(second.id, first.id);
    expect(group.getAllByRole("button", { name: /^(First|Second|Third)$/ }).map((row) => row.textContent)).toEqual(["First", "Second", "Third"]);
    await userEvent.click(group.getByRole("button", { name: "Thread actions for Second" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(move).toHaveBeenLastCalledWith(second.id, null);
  });

  it("does not move down beyond an unknown page boundary", async () => {
    const move = mount({ threads: [first, second], hasMore: true });
    await userEvent.click(screen.getByRole("button", { name: "Thread actions for First" }));
    expect(await screen.findByRole("menuitem", { name: "Move down" })).toBeDisabled();
    expect(move).not.toHaveBeenCalled();
  });

  it("keeps pin state authoritative while a native pin request is pending", () => {
    const unpin = vi.fn();
    mount({ pinPending: true, onUnpinThread: unpin });
    const buttons = screen.getAllByRole("button", { name: "Unpin thread" });
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(buttons[0]);
    expect(unpin).not.toHaveBeenCalled();
  });
});
