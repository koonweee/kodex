import { createClientRequestId } from "../shared/id";
import type { TimelineItem } from "../timeline/state";

const PREFIX = "kodex-question-reply:v1:";

export function asyncQuestionKey(item: TimelineItem, index: number): string {
  return JSON.stringify([item.turnId, item.serverItemId ?? item.id, index]);
}

// Native userMessage.clientId persists this correlation alongside the answer.
// Every explicit attempt still has its own ID; this is not an idempotency key.
export function questionReplyClientId(key: string): string {
  return PREFIX + JSON.stringify([key, createClientRequestId()]);
}

export function canonicalQuestionAnswers(items: TimelineItem[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const item of items) {
    if (item.kind !== "user_message" || item.source === "optimistic" || !item.clientId?.startsWith(PREFIX)) continue;
    try {
      const value: unknown = JSON.parse(item.clientId.slice(PREFIX.length));
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string" || !value[1]) continue;
      const key: unknown = JSON.parse(value[0]);
      if (!Array.isArray(key) || key.length !== 3 || (key[0] !== null && typeof key[0] !== "string") || typeof key[1] !== "string" || !Number.isSafeInteger(key[2]) || key[2] < 0) continue;
      if (!Object.hasOwn(answers, value[0])) answers[value[0]] = item.text;
    } catch { /* Ordinary or malformed native correlation IDs carry no question answer. */ }
  }
  return answers;
}
