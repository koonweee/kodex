import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Approval, ThreadSummary } from "../api/client";
import { areThreadListRowPropsEqual, ThreadListRow, type ThreadListRowProps } from "./WorkspaceSidebar";

const approvals: Approval[] = [];
const pendingTitleThreadIds = new Set<string>();
const onArchiveThread = vi.fn();
const onPinThread = vi.fn();
const onSelectThread = vi.fn();
const onThreadActionHoverChange = vi.fn();
const onUnpinThread = vi.fn();
const thread = threadSummary("thread-1");

function threadSummary(id: string): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
    notificationsEnabled: true,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "notLoaded",
    unreadCompletedAgentTurn: false,
    updatedAt: 1,
  };
}

function rowProps(overrides: Partial<ThreadListRowProps> = {}): ThreadListRowProps {
  return {
    approvals,
    isSelected: false,
    onArchiveThread,
    onPinThread,
    onSelectThread,
    onThreadActionHoverChange,
    onUnpinThread,
    pendingTitleThreadIds,
    showThreadArchiveAction: false,
    thread,
    ...overrides,
  };
}

describe("ThreadListRow memo comparison", () => {
  it("keeps unchanged rows isolated when sibling selection or hover state changes", () => {
    const unchangedRow = rowProps();
    const previouslySelectedRow = rowProps({ isSelected: true });
    const newlyHoveredRow = rowProps({ showThreadArchiveAction: true });
    const newlyPinnedRow = rowProps({ thread: { ...thread, pinnedAt: "2026-05-06T00:00:00Z" } });

    expect(areThreadListRowPropsEqual(unchangedRow, { ...unchangedRow })).toBe(true);
    expect(areThreadListRowPropsEqual(unchangedRow, previouslySelectedRow)).toBe(false);
    expect(areThreadListRowPropsEqual(unchangedRow, newlyHoveredRow)).toBe(false);
    expect(areThreadListRowPropsEqual(unchangedRow, newlyPinnedRow)).toBe(false);
  });
});

describe("ThreadListRow layout and actions", () => {
  it("reserves shared leading and trailing rails for unpinned thread rows", () => {
    renderThreadRow();

    const row = screen.getByRole("button", { name: "thread-1" }).closest(".kodex-thread-list-button");

    expect(row?.querySelector(".kodex-sidebar-row-leading")).toBeInTheDocument();
    expect(row?.querySelector(".kodex-sidebar-row-trailing")).toBeInTheDocument();
    expect(row?.querySelector(".kodex-sidebar-row-leading [aria-label='Pin thread']")).toBeInTheDocument();
  });

  it("keeps select, pin, and archive actions separate inside the shared row frame", () => {
    const onArchive = vi.fn();
    const onPin = vi.fn();
    const onSelect = vi.fn();

    renderThreadRow({
      onArchiveThread: onArchive,
      onPinThread: onPin,
      onSelectThread: onSelect,
      showThreadArchiveAction: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pin thread" }));
    expect(onPin).toHaveBeenCalledWith("thread-1");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Archive thread-1" }));
    expect(onArchive).toHaveBeenCalledWith("thread-1");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "thread-1" }));
    expect(onSelect).toHaveBeenCalledWith("thread-1");
  });

  it("only exposes hover actions for mouse pointers", () => {
    const onHoverChange = vi.fn();
    renderThreadRow({ onThreadActionHoverChange: onHoverChange });

    const row = screen.getByRole("button", { name: "thread-1" }).closest(".kodex-thread-list-button");
    expect(row).toBeInTheDocument();

    fireEvent.pointerEnter(row!, { pointerType: "touch" });
    fireEvent.pointerLeave(row!, { pointerType: "touch" });
    expect(onHoverChange).not.toHaveBeenCalled();

    fireEvent.pointerEnter(row!, { pointerType: "mouse" });
    expect(onHoverChange).toHaveBeenCalledWith("thread-1");

    fireEvent.pointerLeave(row!, { pointerType: "mouse" });
    expect(onHoverChange).toHaveBeenLastCalledWith(null);
  });

  it("does not expose hover actions from touch-driven focus", () => {
    const onHoverChange = vi.fn();
    renderThreadRow({ onThreadActionHoverChange: onHoverChange });

    const selectButton = screen.getByRole("button", { name: "thread-1" });
    const row = selectButton.closest(".kodex-thread-list-button");
    expect(row).toBeInTheDocument();

    fireEvent.pointerDown(row!, { pointerType: "touch" });
    fireEvent.focus(selectButton);
    expect(onHoverChange).not.toHaveBeenCalled();

    fireEvent.blur(selectButton, { relatedTarget: null });
    fireEvent.focus(selectButton);
    expect(onHoverChange).toHaveBeenCalledWith("thread-1");
  });
});

function renderThreadRow(overrides: Partial<ThreadListRowProps> = {}) {
  return render(
    createElement(MantineProvider, null, createElement(ThreadListRow, rowProps(overrides))),
  );
}
