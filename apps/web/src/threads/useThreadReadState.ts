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
  viewedThreadIdsRef: MutableRefObject<Set<string>>;
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
  viewedThreadIdsRef,
  threadsByProjectId,
  updateThreadEverywhere,
}: UseThreadReadStateParams) {
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const pinnedThreadsRef = useRef<ThreadSummary[]>([]);
  const pendingSeenByThreadIdRef = useRef<Map<string, number>>(new Map());
  const confirmedSeenByThreadIdRef = useRef<Map<string, number>>(new Map());

  threadsByProjectIdRef.current = threadsByProjectId;
  chatThreadsRef.current = chatThreads;
  pinnedThreadsRef.current = pinnedThreads;

  function applyCompletedAgentTurnEvent(event: EventEnvelope) {
    const completedTurn = completedAgentTurnEvent(event);
    if (!completedTurn) {
      return;
    }
    const isViewed =
      completedTurn.threadId === selectedThreadIdRef.current ||
      viewedThreadIdsRef.current.has(completedTurn.threadId);
    if (isViewed) {
      void persistCompletedAgentTurnSeen(completedTurn.threadId, undefined);
      return;
    }
    updateThreadEverywhere(completedTurn.threadId, (thread) => {
      const lastCompletedAgentTurnSeq = Math.max(
        thread.lastCompletedAgentTurnSeq ?? 0,
        (thread.seenCompletedAgentTurnSeq ?? 0) + 1,
      );
      return {
        ...thread,
        lastCompletedAgentTurnSeq,
        status: "idle",
        unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > (thread.seenCompletedAgentTurnSeq ?? 0),
      };
    });
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
    const knownSeenCompletedAgentTurnSeq = Math.max(
      thread?.seenCompletedAgentTurnSeq ?? 0,
      pendingSeenByThreadIdRef.current.get(threadId) ?? 0,
      confirmedSeenByThreadIdRef.current.get(threadId) ?? 0,
    );
    if (seenCompletedAgentTurnSeq <= knownSeenCompletedAgentTurnSeq) {
      return;
    }
    void persistCompletedAgentTurnSeen(threadId, seenCompletedAgentTurnSeq);
  }

  async function persistCompletedAgentTurnSeen(threadId: string, seenCompletedAgentTurnSeq?: number) {
    if (seenCompletedAgentTurnSeq !== undefined) {
      pendingSeenByThreadIdRef.current.set(threadId, seenCompletedAgentTurnSeq);
    }
    try {
      const read = await markThreadSeen(threadId, seenCompletedAgentTurnSeq);
      confirmedSeenByThreadIdRef.current.set(
        threadId,
        Math.max(
          confirmedSeenByThreadIdRef.current.get(threadId) ?? 0,
          read.seenCompletedAgentTurnSeq,
        ),
      );
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
    } finally {
      if (
        seenCompletedAgentTurnSeq !== undefined &&
        pendingSeenByThreadIdRef.current.get(threadId) === seenCompletedAgentTurnSeq
      ) {
        pendingSeenByThreadIdRef.current.delete(threadId);
      }
    }
  }

  return { applyCompletedAgentTurnEvent, applyThreadReadStateEvent, markCompletedAgentTurnSeen };
}
