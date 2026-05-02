import type { Approval, ThreadSummary } from "../api/client";
import { asRecord, stringValue } from "../shared/values";

const THREAD_TEXT = {
  new: "New thread",
  untitled: "Untitled thread",
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

export function prependThreadForProject(
  current: ThreadsByProjectId,
  projectId: string,
  thread: ThreadSummary,
): ThreadsByProjectId {
  return {
    ...current,
    [projectId]: [thread, ...(current[projectId] ?? [])],
  };
}

export function removeThreadFromProjects(current: ThreadsByProjectId, threadId: string): ThreadsByProjectId {
  let changed = false;
  const next: ThreadsByProjectId = {};

  for (const [projectId, threads] of Object.entries(current)) {
    const projectThreads = threads.filter((thread) => thread.id !== threadId);
    next[projectId] = projectThreads;
    changed ||= projectThreads.length !== threads.length;
  }

  return changed ? next : current;
}

export function replaceThreadInProjects(
  current: ThreadsByProjectId,
  thread: ThreadSummary,
  fallbackProjectId: string | null,
): ThreadsByProjectId {
  const projectId = projectIdForThread(current, thread, fallbackProjectId);
  if (!projectId) {
    return current;
  }

  return {
    ...current,
    [projectId]: (current[projectId] ?? []).map((item) => (item.id === thread.id ? thread : item)),
  };
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

export function updateThreadReadStateInProjects(
  current: ThreadsByProjectId,
  threadId: string,
  update: (thread: ThreadSummary) => Partial<ThreadSummary>,
): ThreadsByProjectId {
  let changed = false;
  const next: ThreadsByProjectId = {};

  for (const [projectId, threads] of Object.entries(current)) {
    next[projectId] = threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }
      changed = true;
      return { ...thread, ...update(thread) };
    });
  }

  return changed ? next : current;
}

export function updateThreadNameInProjects(
  current: ThreadsByProjectId,
  threadId: string,
  name: string,
): ThreadsByProjectId {
  let changed = false;
  const next: ThreadsByProjectId = {};

  for (const [projectId, threads] of Object.entries(current)) {
    next[projectId] = threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }
      changed = true;
      return { ...thread, name };
    });
  }

  return changed ? next : current;
}

export function threadDisplayTitle(thread: ThreadSummary): string {
  return (
    threadNameTitle(thread) ??
    normalizeTitle(previewTitle(thread.preview)) ??
    `${THREAD_TEXT.untitled} ${thread.id.slice(0, 8)}`
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

function threadStatusNeedsApproval(thread: ThreadSummary): boolean {
  return typeof thread.status === "string" && thread.status.toLowerCase().includes("approval");
}

function projectIdForThread(
  current: ThreadsByProjectId,
  thread: ThreadSummary,
  fallbackProjectId: string | null,
): string | null {
  const explicitProjectId = stringValue((thread as { projectId?: unknown }).projectId);
  if (explicitProjectId) {
    return explicitProjectId;
  }

  return Object.entries(current).find(([, threads]) => threads.some((item) => item.id === thread.id))?.[0] ?? fallbackProjectId;
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
