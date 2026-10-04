import { useEffect, useEffectEvent, useRef } from "react";

import { GatewayRequestError, markThreadSeen, type ThreadRead, type ThreadSummary } from "../api/client";
import type { TimelineTurn } from "../timeline/state";

export function useThreadReadState({
  thread, turns, isVisible, onRead, onRefresh, onError,
}: {
  thread: ThreadSummary | null;
  turns: TimelineTurn[];
  isVisible: boolean;
  onRead: (read: ThreadRead) => void;
  onRefresh: () => void;
  onError: (error: unknown) => void;
}) {
  const attemptedRef = useRef<string | null>(null);
  const currentThreadIdRef = useRef(thread?.id);
  currentThreadIdRef.current = thread?.id;
  useEffect(() => {
    currentThreadIdRef.current = thread?.id;
    return () => { currentThreadIdRef.current = undefined; };
  }, [thread?.id]);
  const hasVisibleCompletion = turns.some((turn) =>
    turn.turnId === thread?.latestCompletedTurnId &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted"),
  );
  const acknowledge = useEffectEvent(() => {
    if (!isVisible || document.visibilityState !== "visible" || !hasVisibleCompletion ||
      !thread?.readStateKnown || !thread.unreadCompletedAgentTurn || !thread.latestCompletedTurnId) return;
    const key = JSON.stringify([thread.id, thread.latestCompletedTurnId, thread.readRevision]);
    if (attemptedRef.current === key) return;
    // Deduplicate this displayed revision only. The gateway owns whether it was
    // seen; a conflict needs fresh canonical visible data, never a guessed ID.
    attemptedRef.current = key;
    const threadId = thread.id;
    void markThreadSeen(thread.id, { completedTurnId: thread.latestCompletedTurnId, readRevision: thread.readRevision })
      .then((read) => { if (currentThreadIdRef.current === threadId) onRead(read); })
      .catch((error: unknown) => {
        if (currentThreadIdRef.current !== threadId) return;
        if (error instanceof GatewayRequestError && error.status === 409) onRefresh();
        else {
          if (attemptedRef.current === key) attemptedRef.current = null;
          onError(error);
        }
      });
  });

  useEffect(() => {
    acknowledge();
  }, [hasVisibleCompletion, isVisible, thread]);
  useEffect(() => {
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, []);
}
