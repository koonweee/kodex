import type { FormEvent, KeyboardEvent } from "react";
import { isTouchInputDevice } from "../shared/inputCapabilities";

export function composerSubmissionIntent(event: FormEvent): "send" | "sendNow" | "queue" {
  const submitter = "submitter" in event.nativeEvent ? event.nativeEvent.submitter : null;
  const intent = submitter instanceof HTMLElement ? submitter.dataset.submitIntent : undefined;
  return intent === "sendNow" || intent === "queue" ? intent : "send";
}

export function isSendNowShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === "Enter" && event.metaKey && !event.shiftKey && !event.nativeEvent.isComposing;
}

export function submitComposerFromKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  // Keep the capability-based Enter/newline policy independent of pane layout.
  if (isTouchInputDevice() && !event.metaKey) return;
  event.preventDefault();
  const form = event.currentTarget.form;
  if (isSendNowShortcut(event)) {
    const submitter = form?.querySelector<HTMLButtonElement>('button[data-submit-intent="sendNow"]');
    if (submitter && !submitter.disabled) form?.requestSubmit(submitter);
    return;
  }
  form?.requestSubmit();
}
