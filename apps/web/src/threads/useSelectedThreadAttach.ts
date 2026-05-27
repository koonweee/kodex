import { useEffect } from "react";

import { attachThread, type ThreadSummary } from "../api/client";
import { selectedThreadShouldAttachLive } from "./selection";

type CurrentRef<T> = { current: T };

export function useSelectedThreadAttach({
  attachingThreadIdsRef,
  isSelectedThreadSnapshotDeferred,
  onAttachedThread,
  onError,
  selectedThread,
}: {
  attachingThreadIdsRef: CurrentRef<Set<string>>;
  isSelectedThreadSnapshotDeferred: boolean;
  onAttachedThread: (thread: ThreadSummary) => void;
  onError: (error: unknown, context: string) => void;
  selectedThread: ThreadSummary | null;
}) {
  useEffect(() => {
    if (isSelectedThreadSnapshotDeferred) {
      return;
    }
    if (!selectedThread || !selectedThreadShouldAttachLive(selectedThread)) {
      return;
    }
    if (attachingThreadIdsRef.current.has(selectedThread.id)) {
      return;
    }

    let cancelled = false;
    attachingThreadIdsRef.current.add(selectedThread.id);
    const attachingThreadId = selectedThread.id;
    attachThread(attachingThreadId)
      .then((response) => {
        attachingThreadIdsRef.current.delete(attachingThreadId);
        if (!cancelled && response.thread) {
          onAttachedThread(response.thread);
        }
      })
      .catch((error) => {
        attachingThreadIdsRef.current.delete(attachingThreadId);
        if (!cancelled) {
          onError(error, `Selected thread attach failed (${attachingThreadId})`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSelectedThreadSnapshotDeferred, selectedThread?.id, selectedThread?.status]);
}
