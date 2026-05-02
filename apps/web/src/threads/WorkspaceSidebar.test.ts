import { describe, expect, it, vi } from "vitest";

import type { Approval, ThreadSummary } from "../api/client";
import { areThreadListRowPropsEqual, type ThreadListRowProps } from "./WorkspaceSidebar";

const approvals: Approval[] = [];
const pendingTitleThreadIds = new Set<string>();
const onArchiveThread = vi.fn();
const onSelectThread = vi.fn();
const onThreadActionHoverChange = vi.fn();
const thread = threadSummary("thread-1");

function threadSummary(id: string): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
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
    onSelectThread,
    onThreadActionHoverChange,
    pendingTitleThreadIds,
    projectId: "project-1",
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

    expect(areThreadListRowPropsEqual(unchangedRow, { ...unchangedRow })).toBe(true);
    expect(areThreadListRowPropsEqual(unchangedRow, previouslySelectedRow)).toBe(false);
    expect(areThreadListRowPropsEqual(unchangedRow, newlyHoveredRow)).toBe(false);
  });
});
