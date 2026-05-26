import { useRef, type MutableRefObject } from "react";

import { markThreadSeen, type EventEnvelope, type ThreadSummary } from "../api/client";
import { mergeThreadReadState } from "./cache";
import { completedAgentTurnEvent, threadReadUpdateFromEvent } from "./events";
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

  threadsByProjectIdRef.current = threadsByProjectId;
  chatThreadsRef.current = chatThreads;
  pinnedThreadsRef.current = pinnedThreads;

  function applyCompletedAgentTurnEvent(event: EventEnvelope) {
    const completedTurn = completedAgentTurnEvent(event);
    if (!completedTurn) {
      return;
    }
    const isSelected = completedTurn.threadId === selectedThreadIdRef.current;
    if (isSelected) {
      void persistCompletedAgentTurnSeen(completedTurn.threadId, undefined);
      return;
    }
    updateThreadEverywhere(completedTurn.threadId, (thread) => ({ ...thread, status: "idle" }));
  }

  function applyThreadReadStateEvent(event: EventEnvelope) {
    const readState = threadReadUpdateFromEvent(event);
    if (!readState) {
      return;
    }
    updateThreadEverywhere(readState.threadId, (thread) => mergeThreadReadState(thread, readState, event.seq));
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
    void persistCompletedAgentTurnSeen(threadId, seenCompletedAgentTurnSeq);
  }

  async function persistCompletedAgentTurnSeen(threadId: string, seenCompletedAgentTurnSeq?: number) {
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

  return { applyCompletedAgentTurnEvent, applyThreadReadStateEvent, markCompletedAgentTurnSeen };
}
