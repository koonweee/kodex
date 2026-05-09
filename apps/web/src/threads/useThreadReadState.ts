import { useEffect, useRef, type MutableRefObject } from "react";

import { markThreadSeen, type EventEnvelope, type ThreadSummary } from "../api/client";
import { completedAgentTurnEvent } from "./events";
import { threadById, type ThreadsByProjectId } from "./helpers";

type UseThreadReadStateParams = {
  onError: (error: unknown) => void;
  chatThreads: ThreadSummary[];
  pinnedThreads: ThreadSummary[];
  selectedThreadIdRef: MutableRefObject<string | null>;
  threadsByProjectId: ThreadsByProjectId;
  updateThreadEverywhere: (
    threadId: string,
    patcher: (thread: ThreadSummary) => ThreadSummary,
  ) => void;
};

export function useThreadReadState({
  chatThreads,
  onError,
  pinnedThreads,
  selectedThreadIdRef,
  threadsByProjectId,
  updateThreadEverywhere,
}: UseThreadReadStateParams) {
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const pinnedThreadsRef = useRef<ThreadSummary[]>([]);

  useEffect(() => {
    threadsByProjectIdRef.current = threadsByProjectId;
    chatThreadsRef.current = chatThreads;
    pinnedThreadsRef.current = pinnedThreads;
  }, [chatThreads, pinnedThreads, threadsByProjectId]);

  function applyCompletedAgentTurnEvent(event: EventEnvelope) {
    const completedTurn = completedAgentTurnEvent(event);
    if (!completedTurn) {
      return;
    }
    const thread =
      threadById(threadsByProjectIdRef.current, completedTurn.threadId) ??
      chatThreadsRef.current.find((thread) => thread.id === completedTurn.threadId) ??
      pinnedThreadsRef.current.find((thread) => thread.id === completedTurn.threadId) ??
      null;
    if (!thread) {
      return;
    }
    const knownCompletedAgentTurnSeq = Math.max(
      thread.lastCompletedAgentTurnSeq ?? 0,
      thread.seenCompletedAgentTurnSeq ?? 0,
    );
    const nextCompletedAgentTurnSeq = knownCompletedAgentTurnSeq + 1;
    if (nextCompletedAgentTurnSeq <= (thread.seenCompletedAgentTurnSeq ?? 0)) {
      return;
    }
    const isSelected = completedTurn.threadId === selectedThreadIdRef.current;
    updateThreadEverywhere(completedTurn.threadId, (thread) => {
      const lastCompletedAgentTurnSeq = Math.max(thread.lastCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq);
      const seenCompletedAgentTurnSeq = isSelected
        ? Math.max(thread.seenCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq)
        : (thread.seenCompletedAgentTurnSeq ?? 0);
      return {
        ...thread,
        lastCompletedAgentTurnSeq,
        seenCompletedAgentTurnSeq,
        status: "idle",
        unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > seenCompletedAgentTurnSeq,
      };
    });
    if (isSelected) {
      void persistCompletedAgentTurnSeen(completedTurn.threadId, nextCompletedAgentTurnSeq);
    }
  }

  function markCompletedAgentTurnSeen(threadId: string, lastCompletedAgentTurnSeq?: number | null) {
    const thread =
      threadById(threadsByProjectIdRef.current, threadId) ??
      chatThreadsRef.current.find((thread) => thread.id === threadId) ??
      pinnedThreadsRef.current.find((thread) => thread.id === threadId) ??
      null;
    const seenCompletedAgentTurnSeq = lastCompletedAgentTurnSeq ?? thread?.lastCompletedAgentTurnSeq ?? 0;
    if (seenCompletedAgentTurnSeq <= (thread?.seenCompletedAgentTurnSeq ?? 0)) {
      return;
    }
    updateThreadEverywhere(threadId, (thread) => ({
      ...thread,
      lastCompletedAgentTurnSeq: seenCompletedAgentTurnSeq,
      seenCompletedAgentTurnSeq,
      unreadCompletedAgentTurn: false,
    }));
    void persistCompletedAgentTurnSeen(threadId, seenCompletedAgentTurnSeq);
  }

  async function persistCompletedAgentTurnSeen(threadId: string, seenCompletedAgentTurnSeq: number) {
    try {
      const read = await markThreadSeen(threadId, seenCompletedAgentTurnSeq);
      updateThreadEverywhere(threadId, (thread) => {
        const nextSeenSeq = Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq);
        return {
          ...thread,
          seenCompletedAgentTurnSeq: nextSeenSeq,
          unreadCompletedAgentTurn: (thread.lastCompletedAgentTurnSeq ?? 0) > nextSeenSeq,
        };
      });
    } catch (error) {
      onError(error);
    }
  }

  return { applyCompletedAgentTurnEvent, markCompletedAgentTurnSeen };
}
