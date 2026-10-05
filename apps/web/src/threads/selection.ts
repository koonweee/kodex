import type { ThreadSummary } from "../api/client";
import type { ThreadsByProjectId } from "./helpers";

export type KnownThreadSelection =
  | { kind: "chat" }
  | { kind: "project"; projectId: string };

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
  const pinnedThread = pinnedThreads.find((thread) => thread.id === threadId);
  if (pinnedThread) return pinnedThread.projectId ? { kind: "project", projectId: pinnedThread.projectId } : { kind: "chat" };
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

export function withThreadNotificationsEnabled(thread: ThreadSummary, notificationsEnabled: boolean): ThreadSummary {
  return { ...thread, notificationsEnabled };
}
