import type { Approval, ThreadSummary } from "../api/client";
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
