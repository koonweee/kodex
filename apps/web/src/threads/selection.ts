import type { ThreadSubagentSummary, ThreadSummary } from "../api/client";
import type { ThreadsByProjectId } from "./helpers";

export type KnownThreadSelection =
  | { kind: "chat" }
  | { kind: "pinned" }
  | { kind: "project"; projectId: string };

export function selectedThreadShouldAttachLive(thread: ThreadSummary): boolean {
  return thread.status === "notLoaded" || thread.status === "active";
}

export function defaultSubagent(subagents: ThreadSubagentSummary[]): ThreadSubagentSummary | null {
  return (
    subagents.find((subagent) => subagent.status === "active" || subagent.liveState === "streaming") ??
    subagents[0] ??
    null
  );
}

export function findKnownThreadSelection(
  threadId: string,
  threadsByProjectId: ThreadsByProjectId,
  chatThreads: ThreadSummary[],
  pinnedThreads: ThreadSummary[],
): KnownThreadSelection | null {
  for (const [projectId, threads] of Object.entries(threadsByProjectId)) {
    if (threads.some((thread) => thread.id === threadId)) {
      return { kind: "project", projectId };
    }
  }
  if (chatThreads.some((thread) => thread.id === threadId)) {
    return { kind: "chat" };
  }
  if (pinnedThreads.some((thread) => thread.id === threadId)) {
    return { kind: "pinned" };
  }
  return null;
}

export function findKnownThread(
  threadId: string,
  threadsByProjectId: ThreadsByProjectId,
  chatThreads: ThreadSummary[],
  pinnedThreads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
): ThreadSummary | null {
  for (const threads of Object.values(threadsByProjectId)) {
    const thread = threads.find((item) => item.id === threadId);
    if (thread) {
      return thread;
    }
  }
  return (
    chatThreads.find((thread) => thread.id === threadId) ??
    pinnedThreads.find((thread) => thread.id === threadId) ??
    (routeSelectedThread?.id === threadId ? routeSelectedThread : null)
  );
}

export function withThreadPinnedAt(thread: ThreadSummary, pinnedAt: string | null): ThreadSummary {
  return { ...thread, pinnedAt };
}

export function withThreadNotificationsEnabled(thread: ThreadSummary, notificationsEnabled: boolean): ThreadSummary {
  return { ...thread, notificationsEnabled };
}
