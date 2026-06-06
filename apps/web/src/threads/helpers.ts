import type { Approval, Project, ThreadSummary } from "../api/client";
import { asRecord, stringValue } from "../shared/values";

const THREAD_TEXT = {
  new: "New thread",
};

export type ThreadsByProjectId = Record<string, ThreadSummary[]>;

export function markThreadTitlePending(current: Set<string>, thread: ThreadSummary): Set<string> {
  if (threadHasDisplayTitle(thread)) {
    return current;
  }
  const next = new Set(current);
  next.add(thread.id);
  return next;
}

export function clearAvailableThreadTitles(current: Set<string>, threads: ThreadSummary[]): Set<string> {
  let next: Set<string> | null = null;
  for (const thread of threads) {
    if (!current.has(thread.id) || !threadHasDisplayTitle(thread)) {
      continue;
    }
    next ??= new Set(current);
    next.delete(thread.id);
  }
  return next ?? current;
}

export function threadById(current: ThreadsByProjectId, threadId: string): ThreadSummary | null {
  for (const threads of Object.values(current)) {
    const thread = threads.find((item) => item.id === threadId);
    if (thread) {
      return thread;
    }
  }
  return null;
}

export function threadDisplayTitle(thread: ThreadSummary): string {
  return (
    threadNameTitle(thread) ??
    normalizeTitle(previewTitle(thread.preview)) ??
    THREAD_TEXT.new
  );
}

export function threadHasDisplayTitle(thread: ThreadSummary): boolean {
  return Boolean(threadNameTitle(thread) ?? normalizeTitle(previewTitle(thread.preview)));
}

export function optimisticThreadSummary(thread: ThreadSummary, firstMessageText: string): ThreadSummary {
  if (threadHasDisplayTitle(thread)) {
    return thread;
  }

  const preview = normalizeTitle(firstMessageText);
  if (!preview) {
    return thread;
  }

  return { ...thread, preview };
}

export function threadNeedsApproval(thread: ThreadSummary, approvals: Approval[]): boolean {
  return approvals.some((approval) => approval.threadId === thread.id && approval.status === "pending") || threadStatusNeedsApproval(thread);
}

export function threadInProgress(thread: ThreadSummary): boolean {
  return typeof thread.status === "string" && thread.status.toLowerCase() === "active";
}

export function sortThreadsForSidebar(
  threads: ThreadSummary[],
  approvals: Approval[],
  pendingTitleThreadIds: Set<string>,
): ThreadSummary[] {
  return [...threads].sort((left, right) => compareSidebarThreads(left, right, approvals, pendingTitleThreadIds));
}

export function sortPinnedThreadsForSidebar(
  threads: ThreadSummary[],
  approvals: Approval[],
  pendingTitleThreadIds: Set<string>,
): ThreadSummary[] {
  return [...threads].sort((left, right) => compareSidebarThreads(left, right, approvals, pendingTitleThreadIds, true));
}

export function sortProjectThreadsForSidebar(
  threads: ThreadSummary[],
  approvals: Approval[],
  pendingTitleThreadIds: Set<string>,
): ThreadSummary[] {
  return [...threads].sort((left, right) => compareProjectSidebarThreads(left, right, approvals, pendingTitleThreadIds));
}

export function withoutPinnedThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.filter((thread) => !threadPinnedAt(thread));
}

export function withPinnedProjectThreads(
  current: ThreadsByProjectId,
  pinnedThreads: ThreadSummary[],
  projects: Project[],
): ThreadsByProjectId {
  let next: ThreadsByProjectId | null = null;
  const projectIds = new Set(projects.map((project) => project.id));
  const projectIdsByCwd = new Map(projects.map((project) => [project.cwd, project.id]));

  for (const thread of pinnedThreads) {
    if (!threadPinnedAt(thread)) {
      continue;
    }
    const projectId = projectIdForPinnedThread(thread, projectIds, projectIdsByCwd);
    if (!projectId) {
      continue;
    }
    const currentMap: ThreadsByProjectId = next ?? current;
    const threads: ThreadSummary[] = currentMap[projectId] ?? [];
    const existingIndex = threads.findIndex((item) => item.id === thread.id);
    const nextThreads =
      existingIndex >= 0
        ? threads.map((item, index) => (index === existingIndex ? { ...item, ...thread } : item))
        : [thread, ...threads];
    next = {
      ...currentMap,
      [projectId]: nextThreads,
    };
  }

  return next ?? current;
}

function compareSidebarThreads(
  left: ThreadSummary,
  right: ThreadSummary,
  approvals: Approval[],
  pendingTitleThreadIds: Set<string>,
  pinnedTieBreaker = false,
): number {
  return (
    threadPriority(left, approvals, pendingTitleThreadIds) - threadPriority(right, approvals, pendingTitleThreadIds) ||
    (pinnedTieBreaker ? comparePinnedAt(left, right) : 0) ||
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    threadDisplayTitle(left).localeCompare(threadDisplayTitle(right)) ||
    left.id.localeCompare(right.id)
  );
}

function compareProjectSidebarThreads(
  left: ThreadSummary,
  right: ThreadSummary,
  approvals: Approval[],
  pendingTitleThreadIds: Set<string>,
): number {
  return (
    comparePinnedAt(left, right) ||
    threadPriority(left, approvals, pendingTitleThreadIds) - threadPriority(right, approvals, pendingTitleThreadIds) ||
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    threadDisplayTitle(left).localeCompare(threadDisplayTitle(right)) ||
    left.id.localeCompare(right.id)
  );
}

function threadPriority(
  thread: ThreadSummary,
  approvals: Approval[],
  pendingTitleThreadIds: Set<string>,
): number {
  if (pendingTitleThreadIds.has(thread.id)) {
    return 0;
  }
  if (threadNeedsApproval(thread, approvals)) {
    return 1;
  }
  return 2;
}

function comparePinnedAt(left: ThreadSummary, right: ThreadSummary): number {
  const leftPinnedAt = threadPinnedAt(left);
  const rightPinnedAt = threadPinnedAt(right);
  if (leftPinnedAt === rightPinnedAt) {
    return 0;
  }
  if (!leftPinnedAt) {
    return 1;
  }
  if (!rightPinnedAt) {
    return -1;
  }
  return Date.parse(rightPinnedAt) - Date.parse(leftPinnedAt);
}

function threadPinnedAt(thread: ThreadSummary): string | null {
  const value = (thread as { pinnedAt?: unknown }).pinnedAt;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectIdForPinnedThread(
  thread: ThreadSummary,
  projectIds: Set<string>,
  projectIdsByCwd: Map<string, string>,
): string | null {
  const explicitProjectId = stringValue((thread as { projectId?: unknown }).projectId);
  if (explicitProjectId && projectIds.has(explicitProjectId)) {
    return explicitProjectId;
  }
  return projectIdsByCwd.get(thread.cwd) ?? null;
}

function threadStatusNeedsApproval(thread: ThreadSummary): boolean {
  return typeof thread.status === "string" && thread.status.toLowerCase().includes("approval");
}

function threadNameTitle(thread: ThreadSummary): string | null {
  const name = normalizeTitle(thread.name ?? null);
  return name === THREAD_TEXT.new ? null : name;
}

function previewTitle(preview: unknown): string | null {
  if (typeof preview === "string") {
    return preview;
  }
  if (preview && typeof preview === "object") {
    const payload = asRecord(preview);
    return stringValue(payload.text) ?? stringValue(payload.summary) ?? stringValue(payload.title);
  }
  return null;
}

function normalizeTitle(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}
