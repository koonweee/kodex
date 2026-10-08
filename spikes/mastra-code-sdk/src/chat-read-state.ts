import type { NativeSession, ProjectRuntime } from './runtime.js';

export type ChatReadState = {
  epoch: string;
  revision: number;
  head: { runId: string; messageId: string | null; reason: 'complete' | 'aborted' | 'error' } | null;
  seen: boolean | null;
};
export type ChatSeenAcknowledgment = {
  bindingId: string; threadId: string; epoch: string; revision: number; runId: string;
};
export type ChatSeenResult = { outcome: 'accepted' | 'conflict'; state: ChatReadState };

/** One live terminal witness per native binding/thread, never reconstructed from
 * history or idle state. A new service epoch intentionally starts unknown. */
export function createChatReadState(epoch: string, changed: (bindingId: string, threadId: string) => void) {
  const bindings = new Map<string, Map<string, ChatReadState>>();
  const sessions = new Map<NativeSession, () => void>();
  const runtimes = new Map<ProjectRuntime, () => void>();
  let revision = 0, disposed = false;
  function read(bindingId: string, threadId: string): ChatReadState {
    const state = bindings.get(bindingId)?.get(threadId);
    return state ? { ...state, head: state.head && { ...state.head } } : { epoch, revision: 0, head: null, seen: null };
  }
  function write(bindingId: string, threadId: string, head: ChatReadState['head'], seen: ChatReadState['seen']) {
    let threads = bindings.get(bindingId);
    if (!threads) { threads = new Map(); bindings.set(bindingId, threads); }
    threads.set(threadId, { epoch, revision: ++revision, head, seen });
    changed(bindingId, threadId);
  }
  function observeSession(session: NativeSession, bindingId: string) {
    if (disposed || sessions.has(session)) return;
    sessions.set(session, session.subscribe(event => {
      if (disposed || event.type !== 'agent_end' || event.reason === 'suspended') return;
      const threadId = session.thread.getId();
      if (!threadId) return;
      // Native emit is synchronous and precedes run.reset(). Display state has
      // already folded this terminal; no persisted-message alias is invented.
      // Read the Session consumer's run, not getCurrentRunId(): the latter
      // prefers the thread producer and can already name a later queued run.
      const runId = session.run.getRunId();
      const reason = event.reason;
      if (!runId || (reason !== 'complete' && reason !== 'aborted' && reason !== 'error')) {
        write(bindingId, threadId, null, null);
        return;
      }
      const message = session.displayState.get().currentMessage;
      // A provider failure before answering may leave the input signal here.
      // That native user row is not a visible terminal assistant witness.
      write(bindingId, threadId, { runId, messageId: message?.role === 'assistant' ? message.id : null, reason }, false);
    }));
  }
  return {
    observeRuntime(runtime: ProjectRuntime, bindingId: string) {
      if (disposed || runtimes.has(runtime)) return;
      // The project factory installs this before exposing the runtime.
      const created = runtime.controller.onSessionCreated(session => observeSession(session, bindingId));
      const deleted = runtime.controller.onSessionDeleted(session => {
        sessions.get(session)?.(); sessions.delete(session);
        // Session retirement does not erase a terminal observed in this epoch.
      });
      runtimes.set(runtime, () => { created(); deleted(); });
    },
    read,
    acknowledge(input: ChatSeenAcknowledgment): ChatSeenResult {
      const state = read(input.bindingId, input.threadId);
      if (disposed || input.epoch !== epoch || input.revision !== state.revision || !state.head || input.runId !== state.head.runId) {
        return { outcome: 'conflict', state };
      }
      if (!state.seen) write(input.bindingId, input.threadId, state.head, true);
      return { outcome: 'accepted', state: read(input.bindingId, input.threadId) };
    },
    forget(bindingId: string, threadIds: string[]) {
      if (disposed) return;
      // Retain only the newer unknown tuple so reconnects cannot revive an old
      // head and exact stale acknowledgments cannot consume later work.
      for (const threadId of new Set(threadIds)) write(bindingId, threadId, null, null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of runtimes.values()) off();
      for (const off of sessions.values()) off();
      runtimes.clear(); sessions.clear();
    },
  };
}
