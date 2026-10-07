import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { submitThreadInput } from "../api/client";
import type { TimelineItem } from "../timeline/state";
import { canonicalQuestionAnswers, questionReplyClientId } from "./asyncQuestionReplies";

type ReplyState = { draft: string; pending: boolean; error?: string };
type Replies = {
  enabled: boolean;
  states: Record<string, ReplyState>;
  setDraft: (key: string, draft: string) => void;
  send: (key: string, text: string, clearDraft: boolean) => Promise<void>;
};
const ReplyContext = createContext<Replies | null>(null);
export const useAsyncQuestionReplies = () => useContext(ReplyContext);

const AnswerContext = createContext<Record<string, string>>({});
export const useAsyncQuestionAnswers = () => useContext(AnswerContext);

export function AsyncQuestionAnswersProvider({ items, children }: { items: TimelineItem[]; children: ReactNode }) {
  const answers = useMemo(() => canonicalQuestionAnswers(items), [items]);
  return <AnswerContext.Provider value={answers}>{children}</AnswerContext.Provider>;
}

// Mounted at pane scope so virtualized rows can unmount without losing drafts.
// Answered state is derived exclusively from native persisted messages and canonical SSE.
export function AsyncQuestionReplyProvider({ threadId, enabled, items = [], children }: {
  threadId: string; enabled: boolean; items?: TimelineItem[]; children: ReactNode;
}) {
  const [states, setStates] = useState<Record<string, ReplyState>>({});
  const answers = useMemo(() => canonicalQuestionAnswers(items), [items]);
  const inFlight = useRef(new Set<string>());
  const update = (key: string, patch: Partial<ReplyState>) => setStates((current) => ({
    ...current, [key]: { ...(current[key] ?? { draft: "", pending: false }), ...patch },
  }));
  async function send(key: string, text: string, clearDraft: boolean) {
    if (!enabled || !text.trim() || inFlight.current.has(key) || Object.hasOwn(answers, key)) return;
    inFlight.current.add(key);
    update(key, { pending: true, error: undefined });
    try {
      await submitThreadInput(threadId, [{ type: "text", text }], [], questionReplyClientId(key));
      update(key, { pending: false, ...(clearDraft ? { draft: "" } : {}) });
    } catch (error) {
      update(key, { pending: false, error: error instanceof Error ? error.message : "Could not send reply" });
    } finally {
      inFlight.current.delete(key);
    }
  }
  return <AnswerContext.Provider value={answers}><ReplyContext.Provider value={{ enabled, states, setDraft: (key, draft) => update(key, { draft }), send }}>{children}</ReplyContext.Provider></AnswerContext.Provider>;
}
