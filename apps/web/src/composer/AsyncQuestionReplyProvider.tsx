import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { submitThreadInput } from "../api/client";
import { createClientRequestId } from "../shared/id";

type ReplyState = { draft: string; pending: boolean; error?: string };
type Replies = {
  enabled: boolean;
  states: Record<string, ReplyState>;
  setDraft: (key: string, draft: string) => void;
  send: (key: string, text: string, clearDraft: boolean) => Promise<void>;
};
const ReplyContext = createContext<Replies | null>(null);
export const useAsyncQuestionReplies = () => useContext(ReplyContext);

// Mounted at pane scope so virtualized rows can unmount without losing drafts.
// No answered/consumed state: submitted replies converge through canonical SSE.
export function AsyncQuestionReplyProvider({ threadId, enabled, children }: {
  threadId: string; enabled: boolean; children: ReactNode;
}) {
  const [states, setStates] = useState<Record<string, ReplyState>>({});
  const inFlight = useRef(new Set<string>());
  const update = (key: string, patch: Partial<ReplyState>) => setStates((current) => ({
    ...current, [key]: { ...(current[key] ?? { draft: "", pending: false }), ...patch },
  }));
  async function send(key: string, text: string, clearDraft: boolean) {
    if (!enabled || !text.trim() || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    update(key, { pending: true, error: undefined });
    try {
      await submitThreadInput(threadId, [{ type: "text", text }], [], createClientRequestId());
      update(key, { pending: false, ...(clearDraft ? { draft: "" } : {}) });
    } catch (error) {
      update(key, { pending: false, error: error instanceof Error ? error.message : "Could not send reply" });
    } finally {
      inFlight.current.delete(key);
    }
  }
  return <ReplyContext.Provider value={{ enabled, states, setDraft: (key, draft) => update(key, { draft }), send }}>{children}</ReplyContext.Provider>;
}
