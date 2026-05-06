import { useState, type Dispatch, type SetStateAction } from "react";

import type { ContextUsage } from "../ComposerFooterControls";
import type { EventEnvelope, ThreadSummary } from "../api/client";
import { contextUsageFromEvent } from "../composer/settings";
import { threadNameUpdateFromEvent, threadStatusUpdateFromEvent } from "./events";
import {
  updateThreadNameInList,
  updateThreadNameInProjects,
  updateThreadReadStateInList,
  updateThreadReadStateInProjects,
  type ThreadsByProjectId,
} from "./helpers";

type UseThreadMetadataParams = {
  selectedThreadId: string | null;
  setPendingTitleThreadIds: Dispatch<SetStateAction<Set<string>>>;
  setChatThreads: Dispatch<SetStateAction<ThreadSummary[]>>;
  setPinnedThreads: Dispatch<SetStateAction<ThreadSummary[]>>;
  setThreadsByProjectId: Dispatch<SetStateAction<ThreadsByProjectId>>;
};

export function useThreadMetadata({
  selectedThreadId,
  setPendingTitleThreadIds,
  setChatThreads,
  setPinnedThreads,
  setThreadsByProjectId,
}: UseThreadMetadataParams) {
  const [contextUsageByThreadId, setContextUsageByThreadId] = useState<Record<string, ContextUsage>>({});
  const selectedContextUsage = selectedThreadId ? contextUsageByThreadId[selectedThreadId] : null;

  function applyThreadMetadataEvent(event: EventEnvelope) {
    const tokenUsage = contextUsageFromEvent(event);
    if (tokenUsage && event.threadId) {
      setContextUsageByThreadId((current) => ({ ...current, [event.threadId as string]: tokenUsage }));
    }

    const statusUpdate = threadStatusUpdateFromEvent(event);
    if (statusUpdate) {
      setThreadsByProjectId((current) =>
        updateThreadReadStateInProjects(current, statusUpdate.threadId, (thread) =>
          thread.status === statusUpdate.status ? {} : { status: statusUpdate.status },
        ),
      );
      setChatThreads((current) =>
        updateThreadReadStateInList(current, statusUpdate.threadId, (thread) =>
          thread.status === statusUpdate.status ? {} : { status: statusUpdate.status },
        ),
      );
      setPinnedThreads((current) =>
        updateThreadReadStateInList(current, statusUpdate.threadId, (thread) =>
          thread.status === statusUpdate.status ? {} : { status: statusUpdate.status },
        ),
      );
    }

    const metadataThread = threadMetadataFromEvent(event);
    if (metadataThread) {
      setThreadsByProjectId((current) =>
        updateThreadReadStateInProjects(current, metadataThread.id, () => ({
          gitInfo: metadataThread.gitInfo,
        })),
      );
      setChatThreads((current) =>
        updateThreadReadStateInList(current, metadataThread.id, () => ({
          gitInfo: metadataThread.gitInfo,
        })),
      );
      setPinnedThreads((current) =>
        updateThreadReadStateInList(current, metadataThread.id, () => ({
          gitInfo: metadataThread.gitInfo,
        })),
      );
    }
    const metadataGitInfo = threadMetadataGitInfoFromEvent(event);
    if (metadataGitInfo) {
      setThreadsByProjectId((current) =>
        updateThreadReadStateInProjects(current, metadataGitInfo.threadId, (thread) => ({
          gitInfo: mergeGitInfoPatch(thread.gitInfo, metadataGitInfo.gitInfo),
        })),
      );
      setChatThreads((current) =>
        updateThreadReadStateInList(current, metadataGitInfo.threadId, (thread) => ({
          gitInfo: mergeGitInfoPatch(thread.gitInfo, metadataGitInfo.gitInfo),
        })),
      );
      setPinnedThreads((current) =>
        updateThreadReadStateInList(current, metadataGitInfo.threadId, (thread) => ({
          gitInfo: mergeGitInfoPatch(thread.gitInfo, metadataGitInfo.gitInfo),
        })),
      );
    }

    const update = threadNameUpdateFromEvent(event);
    if (!update) {
      return;
    }

    const name = update.name?.trim();
    if (name) {
      setThreadsByProjectId((current) => updateThreadNameInProjects(current, update.threadId, name));
      setChatThreads((current) => updateThreadNameInList(current, update.threadId, name));
      setPinnedThreads((current) => updateThreadNameInList(current, update.threadId, name));
      setPendingTitleThreadIds((current) => {
        if (!current.has(update.threadId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(update.threadId);
        return next;
      });
    }
  }

  function applyThreadMetadataEvents(events: EventEnvelope[]) {
    for (const event of events) {
      applyThreadMetadataEvent(event);
    }
  }

  return {
    applyThreadMetadataEvent,
    applyThreadMetadataEvents,
    selectedContextUsage,
  };
}

function threadMetadataFromEvent(event: EventEnvelope): ThreadSummary | null {
  if (event.kind !== "timeline.thread_metadata") {
    return null;
  }
  const payload = event.payload as { thread?: ThreadSummary };
  return payload.thread?.id ? payload.thread : null;
}

function threadMetadataGitInfoFromEvent(
  event: EventEnvelope,
): { threadId: string; gitInfo: GitInfoPatch | null } | null {
  if (event.kind !== "timeline.thread_metadata") {
    return null;
  }
  const payload = event.payload as { gitInfo?: GitInfoPatch | null; thread?: ThreadSummary | null; threadId?: unknown };
  if (payload.thread?.id) {
    return null;
  }
  const threadId = typeof payload.threadId === "string" ? payload.threadId : event.threadId;
  if (!threadId || !("gitInfo" in payload)) {
    return null;
  }
  return { threadId, gitInfo: payload.gitInfo ?? null };
}

type GitInfo = NonNullable<ThreadSummary["gitInfo"]>;
type GitInfoPatch = Partial<Record<keyof GitInfo, string | null>>;

function mergeGitInfoPatch(current: ThreadSummary["gitInfo"], patch: GitInfoPatch | null): ThreadSummary["gitInfo"] {
  if (patch === null) {
    return null;
  }
  const next: GitInfo = { ...(current ?? {}) };
  if ("branch" in patch) {
    next.branch = patch.branch;
  }
  if ("originUrl" in patch) {
    next.originUrl = patch.originUrl;
  }
  if ("sha" in patch) {
    next.sha = patch.sha;
  }
  return next;
}
