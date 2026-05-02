import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { markThreadSeen, type EventEnvelope } from "../api/client";
import { completedAgentTurnEvent } from "./events";
import { threadById, updateThreadReadStateInProjects, type ThreadsByProjectId } from "./helpers";

type UseThreadReadStateParams = {
  onError: (error: unknown) => void;
  selectedThreadIdRef: MutableRefObject<string | null>;
  setThreadsByProjectId: Dispatch<SetStateAction<ThreadsByProjectId>>;
  threadsByProjectId: ThreadsByProjectId;
};

export function useThreadReadState({
  onError,
  selectedThreadIdRef,
  setThreadsByProjectId,
  threadsByProjectId,
}: UseThreadReadStateParams) {
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});

  useEffect(() => {
    threadsByProjectIdRef.current = threadsByProjectId;
  }, [threadsByProjectId]);

  function applyCompletedAgentTurnEvent(event: EventEnvelope) {
    const completedTurn = completedAgentTurnEvent(event);
    if (!completedTurn) {
      return;
    }
    const thread = threadById(threadsByProjectIdRef.current, completedTurn.threadId);
    if (!thread || completedTurn.seq <= (thread.lastCompletedAgentTurnSeq ?? 0)) {
      return;
    }
    const isSelected = completedTurn.threadId === selectedThreadIdRef.current;
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, completedTurn.threadId, (thread) => {
        const lastCompletedAgentTurnSeq = Math.max(thread.lastCompletedAgentTurnSeq ?? 0, completedTurn.seq);
        const seenCompletedAgentTurnSeq = isSelected
          ? Math.max(thread.seenCompletedAgentTurnSeq ?? 0, completedTurn.seq)
          : (thread.seenCompletedAgentTurnSeq ?? 0);
        return {
          lastCompletedAgentTurnSeq,
          seenCompletedAgentTurnSeq,
          unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > seenCompletedAgentTurnSeq,
        };
      }),
    );
    if (isSelected) {
      void persistCompletedAgentTurnSeen(completedTurn.threadId, completedTurn.seq);
    }
  }

  function markCompletedAgentTurnSeen(threadId: string) {
    const thread = threadById(threadsByProjectIdRef.current, threadId);
    const seenCompletedAgentTurnSeq = thread?.lastCompletedAgentTurnSeq ?? 0;
    if (!thread || seenCompletedAgentTurnSeq <= (thread.seenCompletedAgentTurnSeq ?? 0)) {
      return;
    }
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, threadId, () => ({
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
    } catch (error) {
      onError(error);
    }
  }

  return { applyCompletedAgentTurnEvent, markCompletedAgentTurnSeen };
}
