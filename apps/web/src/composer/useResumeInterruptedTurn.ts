import { useRef, useState } from "react";
import { resumeInterruptedTurn } from "../api/client";

type ResumeOptions = {
  threadId: string | null;
  expectedTurnId: string | null;
  onError: (error: unknown) => void;
  onThreadTurnStarted: (threadId: string) => void;
  onRefresh: (threadId: string) => void;
};

export function useResumeInterruptedTurn({ threadId, expectedTurnId, onError, onThreadTurnStarted, onRefresh }: ResumeOptions) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  async function resume() {
    if (!threadId || !expectedTurnId || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await resumeInterruptedTurn(threadId, expectedTurnId);
      onThreadTurnStarted(threadId);
    } catch (error) {
      onError(error);
    } finally {
      onRefresh(threadId);
      inFlight.current = false;
      setPending(false);
    }
  }
  return { pending, resume };
}
