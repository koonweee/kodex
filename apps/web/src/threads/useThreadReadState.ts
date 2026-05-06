import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { markThreadSeen, type EventEnvelope, type ThreadSummary } from "../api/client";
import { completedAgentTurnEvent } from "./events";
import {
  threadById,
  updateThreadReadStateInList,
  updateThreadReadStateInProjects,
  type ThreadsByProjectId,
} from "./helpers";

type UseThreadReadStateParams = {
  onError: (error: unknown) => void;
  chatThreads: ThreadSummary[];
  pinnedThreads: ThreadSummary[];
  selectedThreadIdRef: MutableRefObject<string | null>;
  setChatThreads: Dispatch<SetStateAction<ThreadSummary[]>>;
  setPinnedThreads: Dispatch<SetStateAction<ThreadSummary[]>>;
  setThreadsByProjectId: Dispatch<SetStateAction<ThreadsByProjectId>>;
  threadsByProjectId: ThreadsByProjectId;
};

export function useThreadReadState({
  chatThreads,
  onError,
  pinnedThreads,
  selectedThreadIdRef,
  setChatThreads,
  setPinnedThreads,
  setThreadsByProjectId,
  threadsByProjectId,
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
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, completedTurn.threadId, (thread) => {
        const lastCompletedAgentTurnSeq = Math.max(thread.lastCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq);
        const seenCompletedAgentTurnSeq = isSelected
          ? Math.max(thread.seenCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq)
          : (thread.seenCompletedAgentTurnSeq ?? 0);
        return {
          lastCompletedAgentTurnSeq,
          seenCompletedAgentTurnSeq,
          status: "idle",
          unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > seenCompletedAgentTurnSeq,
        };
      }),
    );
    setChatThreads((current) =>
      updateThreadReadStateInList(current, completedTurn.threadId, (thread) => {
        const lastCompletedAgentTurnSeq = Math.max(thread.lastCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq);
        const seenCompletedAgentTurnSeq = isSelected
          ? Math.max(thread.seenCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq)
          : (thread.seenCompletedAgentTurnSeq ?? 0);
        return {
          lastCompletedAgentTurnSeq,
          seenCompletedAgentTurnSeq,
          status: "idle",
          unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > seenCompletedAgentTurnSeq,
        };
      }),
    );
    setPinnedThreads((current) =>
      updateThreadReadStateInList(current, completedTurn.threadId, (thread) => {
        const lastCompletedAgentTurnSeq = Math.max(thread.lastCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq);
        const seenCompletedAgentTurnSeq = isSelected
          ? Math.max(thread.seenCompletedAgentTurnSeq ?? 0, nextCompletedAgentTurnSeq)
          : (thread.seenCompletedAgentTurnSeq ?? 0);
        return {
          lastCompletedAgentTurnSeq,
          seenCompletedAgentTurnSeq,
          status: "idle",
          unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > seenCompletedAgentTurnSeq,
        };
      }),
    );
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
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, threadId, () => ({
        lastCompletedAgentTurnSeq: seenCompletedAgentTurnSeq,
        seenCompletedAgentTurnSeq,
        unreadCompletedAgentTurn: false,
      })),
    );
    setChatThreads((current) =>
      updateThreadReadStateInList(current, threadId, () => ({
        lastCompletedAgentTurnSeq: seenCompletedAgentTurnSeq,
        seenCompletedAgentTurnSeq,
        unreadCompletedAgentTurn: false,
      })),
    );
    setPinnedThreads((current) =>
      updateThreadReadStateInList(current, threadId, () => ({
        lastCompletedAgentTurnSeq: seenCompletedAgentTurnSeq,
        seenCompletedAgentTurnSeq,
        unreadCompletedAgentTurn: false,
      })),
    );
    void persistCompletedAgentTurnSeen(threadId, seenCompletedAgentTurnSeq);
  }

  async function persistCompletedAgentTurnSeen(threadId: string, seenCompletedAgentTurnSeq: number) {
    try {
      const read = await markThreadSeen(threadId, seenCompletedAgentTurnSeq);
      setThreadsByProjectId((current) =>
        updateThreadReadStateInProjects(current, threadId, (thread) => ({
          seenCompletedAgentTurnSeq: Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq),
          unreadCompletedAgentTurn:
            (thread.lastCompletedAgentTurnSeq ?? 0) >
            Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq),
        })),
      );
      setChatThreads((current) =>
        updateThreadReadStateInList(current, threadId, (thread) => ({
          seenCompletedAgentTurnSeq: Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq),
          unreadCompletedAgentTurn:
            (thread.lastCompletedAgentTurnSeq ?? 0) >
            Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq),
        })),
      );
      setPinnedThreads((current) =>
        updateThreadReadStateInList(current, threadId, (thread) => ({
          seenCompletedAgentTurnSeq: Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq),
          unreadCompletedAgentTurn:
            (thread.lastCompletedAgentTurnSeq ?? 0) >
            Math.max(thread.seenCompletedAgentTurnSeq ?? 0, read.seenCompletedAgentTurnSeq),
        })),
      );
    } catch (error) {
      onError(error);
    }
  }

  return { applyCompletedAgentTurnEvent, markCompletedAgentTurnSeen };
}
