import { useState, type Dispatch, type SetStateAction } from "react";

import type { ContextUsage } from "../ComposerFooterControls";
import type { EventEnvelope } from "../api/client";
import { contextUsageFromEvent } from "../composer/settings";
import { threadNameUpdateFromEvent } from "./events";
import { updateThreadNameInProjects, type ThreadsByProjectId } from "./helpers";

type UseThreadMetadataParams = {
  selectedThreadId: string | null;
  setPendingTitleThreadIds: Dispatch<SetStateAction<Set<string>>>;
  setThreadsByProjectId: Dispatch<SetStateAction<ThreadsByProjectId>>;
};

export function useThreadMetadata({
  selectedThreadId,
  setPendingTitleThreadIds,
  setThreadsByProjectId,
}: UseThreadMetadataParams) {
  const [contextUsageByThreadId, setContextUsageByThreadId] = useState<Record<string, ContextUsage>>({});
  const selectedContextUsage = selectedThreadId ? contextUsageByThreadId[selectedThreadId] : null;

  function applyThreadMetadataEvent(event: EventEnvelope) {
    const tokenUsage = contextUsageFromEvent(event);
    if (tokenUsage && event.threadId) {
      setContextUsageByThreadId((current) => ({ ...current, [event.threadId as string]: tokenUsage }));
    }

    const update = threadNameUpdateFromEvent(event);
    if (!update) {
      return;
    }

    const name = update.name?.trim();
    if (name) {
      setThreadsByProjectId((current) => updateThreadNameInProjects(current, update.threadId, name));
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
