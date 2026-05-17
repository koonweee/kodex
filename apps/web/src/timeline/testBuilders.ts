import type { Approval } from "../api/client";
import type { TimelineItem, TimelineState } from "./reducer";

export function timelineItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: "item-1",
    kind: "assistant_message",
    status: "completed",
    text: "",
    turnId: "turn-1",
    displayOrder: 1,
    payload: {},
    debugEvents: [],
    ...overrides,
  };
}

export function timelineState(overrides: Partial<TimelineState> = {}): TimelineState {
  return {
    activeTurnId: null,
    items: overrides.items ?? [],
    hiddenItems: overrides.hiddenItems ?? [],
    turns: overrides.turns ?? [],
    pendingApprovalRequests: overrides.pendingApprovalRequests ?? [],
    pendingUserInputRequests: overrides.pendingUserInputRequests ?? [],
    lastSeq: 0,
    viewRevision: 0,
    ...overrides,
  };
}

export function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    createdAt: "2026-04-30T00:00:00Z",
    id: "approval-1",
    itemId: null,
    method: "item/commandExecution/requestApproval",
    payload: {},
    requestId: "request-1",
    resolvedAt: null,
    response: null,
    status: "pending",
    threadId: "thread-1",
    turnId: "turn-1",
    ...overrides,
  };
}
