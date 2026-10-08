import type { Chat } from './chat-projects.js';
import type { NativeSession, ProjectRuntime } from './runtime.js';

export type CatalogChat = Chat & { isRunning: boolean };

/** Observe native owners, including children without editable pane handles.
 * The map owns subscriptions only; each snapshot reads native display state. */
export function createChatActivity(changed: () => void) {
  const sessions = new Map<NativeSession, () => void>();
  const runtimes = new Map<ProjectRuntime, () => void>();
  let disposed = false;
  function observeSession(session: NativeSession) {
    if (disposed || sessions.has(session)) return;
    let threadId = session.thread.getId(), running = session.displayState.get().isRunning;
    sessions.set(session, session.subscribe(() => {
      const nextId = session.thread.getId(), nextRunning = session.displayState.get().isRunning;
      if (threadId === nextId && running === nextRunning) return;
      threadId = nextId; running = nextRunning;
      changed();
    }));
    changed();
  }
  return {
    observeRuntime(runtime: ProjectRuntime) {
      if (disposed || runtimes.has(runtime)) return;
      // Install before the project factory exposes its runtime to callers.
      const created = runtime.controller.onSessionCreated(observeSession);
      const deleted = runtime.controller.onSessionDeleted(session => {
        sessions.get(session)?.();
        if (sessions.delete(session)) changed();
      });
      runtimes.set(runtime, () => { created(); deleted(); });
    },
    project<T extends Chat>(chats: T[]): Array<T & { isRunning: boolean }> {
      const running = new Set<string>();
      for (const session of sessions.keys()) {
        const threadId = session.thread.getId();
        if (threadId && session.displayState.get().isRunning) running.add(threadId);
      }
      // Any running native scope makes this thread active. Catalog reads never
      // create a Session, infer completion or retain an activity value.
      return chats.map(chat => ({ ...chat, isRunning: running.has(chat.id) }));
    },
    dispose() {
      disposed = true;
      for (const off of runtimes.values()) off();
      for (const off of sessions.values()) off();
      runtimes.clear(); sessions.clear();
    },
  };
}
