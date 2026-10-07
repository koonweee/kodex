import { useRef, useState } from "react";
import type { FormEvent } from "react";

import type { ComposerDraftControls } from "../composer/ComposerPanel";
import { slashCommandFromSubmittedText } from "../composer/slashCommands";
import { errorMessageFrom } from "../shared/values";
import type { GoalController } from "./controller";

/** Handles goal commands before ordinary Send/Queue can create model input. */
export function useGoalCommand({
  threadId, draftText, hasExtraInput, canSubmit, updateGoal, onOpen,
}: {
  threadId: string | null;
  draftText: string;
  hasExtraInput: boolean;
  canSubmit: boolean;
  updateGoal: GoalController["update"];
  onOpen: () => void;
}) {
  const currentThreadId = useRef(threadId);
  currentThreadId.current = threadId;
  const inFlight = useRef(new Set<string>());
  const [pendingThreads, setPendingThreads] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<{ threadId: string | null; text: string; message: string } | null>(null);

  function handleSubmit(event: FormEvent, controls: ComposerDraftControls): boolean {
    if (slashCommandFromSubmittedText(draftText) !== "goal") return false;
    event.preventDefault();
    if (!canSubmit || (threadId && inFlight.current.has(threadId))) return true;
    const reject = (message: string) => setFailure({ threadId, text: draftText, message });
    setFailure(null);
    if (!threadId) {
      reject("/goal is only available in an existing chat");
      return true;
    }
    const submitter = "submitter" in event.nativeEvent ? event.nativeEvent.submitter : null;
    if (submitter instanceof HTMLElement && submitter.dataset.submitIntent === "queue") {
      reject("/goal cannot be queued. Use Send to set or manage the goal.");
      return true;
    }
    if (hasExtraInput) {
      reject("/goal does not support attachments, annotations, or skill mentions. Remove them before setting a goal.");
      return true;
    }
    const objective = draftText.trim().slice("/goal".length).trim();
    if (!objective) {
      onOpen();
      controls.clearText();
      return true;
    }
    inFlight.current.add(threadId);
    setPendingThreads(new Set(inFlight.current));
    void updateGoal({ objective, status: "active" }).then(() => controls.clearText()).catch((error: unknown) => {
      if (currentThreadId.current === threadId) reject(errorMessageFrom(error));
    }).finally(() => {
      inFlight.current.delete(threadId);
      setPendingThreads(new Set(inFlight.current));
    });
    return true;
  }

  return {
    handleSubmit,
    pending: threadId !== null && pendingThreads.has(threadId),
    error: failure?.threadId === threadId && failure.text === draftText ? failure.message : null,
  };
}
