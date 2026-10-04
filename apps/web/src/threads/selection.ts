import type { ThreadSubagentSummary, ThreadSummary } from "../api/client";
import type { ThreadsByProjectId } from "./helpers";

export type KnownThreadSelection =
  | { kind: "chat" }
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
  sectionThreads: ThreadSummary[],
): KnownThreadSelection | null {
  for (const [projectId, threads] of Object.entries(threadsByProjectId)) {
    if (threads.some((thread) => thread.id === threadId)) {
      return { kind: "project", projectId };
    }
  }
  if (chatThreads.some((thread) => thread.id === threadId)) {
    return { kind: "chat" };
  }
  const sectionThread = sectionThreads.find((thread) => thread.id === threadId);
  if (sectionThread) return sectionThread.projectId ? { kind: "project", projectId: sectionThread.projectId } : { kind: "chat" };
  return null;
}

export function findKnownThread(
  threadId: string,
  threadsByProjectId: ThreadsByProjectId,
  chatThreads: ThreadSummary[],
  sectionThreads: ThreadSummary[],
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
    sectionThreads.find((thread) => thread.id === threadId) ??
    (routeSelectedThread?.id === threadId ? routeSelectedThread : null)
  );
}

export function withThreadNotificationsEnabled(thread: ThreadSummary, notificationsEnabled: boolean): ThreadSummary {
  return { ...thread, notificationsEnabled };
}
