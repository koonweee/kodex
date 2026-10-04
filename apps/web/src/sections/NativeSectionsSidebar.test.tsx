import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { createThreadSection, renameThreadSection, deleteThreadSection, type ThreadSummary } from "../api/client";
import { NativeSectionsSidebar } from "./NativeSectionsSidebar";
import { PINNED_SECTION_ID } from "./cache";

vi.mock("../api/client", () => ({ createThreadSection: vi.fn(), renameThreadSection: vi.fn(), deleteThreadSection: vi.fn() }));
const section = { id: "custom-section", name: "Research" };
const pinned = { id: PINNED_SECTION_ID, name: "Pinned" };
function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return { parentThreadId: null, canAcceptDirectInput: null, id, name: id, section, projectId: "project-1", createdAt: 1, updatedAt: 1, cwd: "/repo", status: "idle", notificationsEnabled: true, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false, rawPayload: {}, ...overrides };
}
const first = thread("Native first", { sectionEnteredAt: 99 });
const second = thread("Native second", { status: "active", updatedAt: 100, sectionEnteredAt: 1 });
const third = thread("Native third", { unreadCompletedAgentTurn: true });
function props(overrides: Partial<ComponentProps<typeof NativeSectionsSidebar>> = {}): ComponentProps<typeof NativeSectionsSidebar> {
  return { sections: [section, pinned], threadsBySectionId: { [section.id]: [first, second, third] }, collapsedSectionIds: new Set(), onToggleSection: vi.fn(), searchQuery: "", hasMoreById: {}, paginationStates: {}, approvals: [], hoveredThreadActionId: null, onArchiveThread: vi.fn(), onPinThread: vi.fn(), onUnpinThread: vi.fn(), onSelectThread: vi.fn(), onThreadActionHoverChange: vi.fn(), pendingTitleThreadIds: new Set(), selectedThreadId: null, onMoveThreadToSection: vi.fn(), ...overrides };
}
function mount(initial = props()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<NativeSectionsSidebar {...initial} />, { wrapper: ({ children }) => <QueryClientProvider client={client}><MantineProvider env="test">{children}</MantineProvider></QueryClientProvider> });
}
beforeEach(() => vi.clearAllMocks());

describe("native section controls", () => {
  it("exposes section destinations directly after opening a row menu with touch", async () => {
    const onMoveThreadToSection = vi.fn();
    mount(props({ onMoveThreadToSection }));
    const trigger = screen.getByRole("button", { name: "Thread actions for Native first" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pinned" }));
    expect(onMoveThreadToSection).toHaveBeenCalledWith(first.id, PINNED_SECTION_ID);
  });

  it("moves only the acted-on chat when another client has moved its old neighbor elsewhere", async () => {
    const memberships = new Map([[first.id, section.id], [second.id, section.id]]);
    const onMoveThreadToSection = vi.fn((id: string, sectionId: string | null) => {
      if (sectionId) memberships.set(id, sectionId); else memberships.delete(id);
    });
    mount(props({ threadsBySectionId: { [section.id]: [first, second] }, onMoveThreadToSection }));
    // A second client changes native membership while this tab retains its old snapshot.
    memberships.set(second.id, "other-native-section");
    await userEvent.click(screen.getByRole("button", { name: "Thread actions for Native first" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(memberships.get(second.id)).toBe("other-native-section");
    expect(onMoveThreadToSection).toHaveBeenCalledWith(first.id, section.id, null);
  });

  it("does not turn a down move at an unloaded page boundary into an append", async () => {
    const onMoveThreadToSection = vi.fn();
    mount(props({ threadsBySectionId: { [section.id]: [first, second] }, hasMoreById: { [section.id]: true }, onMoveThreadToSection }));
    await userEvent.click(screen.getByRole("button", { name: "Thread actions for Native first" }));
    expect(await screen.findByRole("menuitem", { name: "Move down" })).toBeDisabled();
    expect(onMoveThreadToSection).not.toHaveBeenCalled();
  });

  it("preserves native member order and sends relative move and section membership intents", async () => {
    const onMoveThreadToSection = vi.fn();
    mount(props({ onMoveThreadToSection }));
    const group = screen.getByRole("group", { name: "Research section" });
    expect(within(group).getAllByRole("button").filter((button) => [first.name, second.name, third.name].includes(button.textContent ?? "")).map((button) => button.textContent))
      .toEqual([first.name, second.name, third.name]);
    await userEvent.click(screen.getByRole("button", { name: "Thread actions for Native second" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
    expect(onMoveThreadToSection).toHaveBeenLastCalledWith(second.id, section.id, first.id);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Move up" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Thread actions for Native second" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(onMoveThreadToSection).toHaveBeenLastCalledWith(second.id, section.id, null);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Move down" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Thread actions for Native second" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pinned" }));
    expect(onMoveThreadToSection).toHaveBeenLastCalledWith(second.id, PINNED_SECTION_ID);
    expect(within(group).getByRole("button", { name: second.name! })).toBeInTheDocument();
  });

  it("creates and renames only after native responses and keeps returned headings authoritative", async () => {
    vi.mocked(createThreadSection).mockResolvedValue({ id: "new-section", name: "Later" });
    vi.mocked(renameThreadSection).mockResolvedValue({ ...section, name: "Updated" });
    const onSectionsChanged = vi.fn();
    mount(props({ onSectionsChanged }));
    await userEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Section name/ }), { target: { value: "Later" } });
    await userEvent.click(screen.getByRole("button", { name: "Create section" }));
    await waitFor(() => expect(createThreadSection).toHaveBeenCalledWith("Later"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Later section" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Research" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename section" }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Section name/ }), { target: { value: "Updated" } });
    await userEvent.click(screen.getByRole("button", { name: "Save section" }));
    await waitFor(() => expect(renameThreadSection).toHaveBeenCalledWith(section.id, "Updated"));
    expect(onSectionsChanged).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("group", { name: "Research section" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Section actions for Pinned" })).not.toBeInTheDocument();
  });

  it("deletes custom sections through the native command and requests a full refill", async () => {
    vi.mocked(deleteThreadSection).mockResolvedValue();
    const onSectionsChanged = vi.fn();
    mount(props({ onSectionsChanged }));
    await userEvent.click(screen.getByRole("button", { name: "Section actions for Research" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete section" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete section" }));
    await waitFor(() => expect(deleteThreadSection).toHaveBeenCalledWith(section.id));
    expect(onSectionsChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: first.name! })).toBeInTheDocument();
  });
});
