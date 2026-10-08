import type { Chat } from './chat-projects.js';
import type { NativeSession } from './runtime.js';

export type CatalogChat = Chat & { isRunning: boolean };
interface ActivityHandle { session: NativeSession; observers: Pick<AbortController, 'signal'> }

/** Snapshot only: existing host bindings lend their current native display state.
 * Catalog reads never mount Sessions or retain a separate activity value. */
export async function projectChatActivity(chats: Chat[], handles: Iterable<Promise<ActivityHandle>>): Promise<CatalogChat[]> {
  const mounted = new Map<string, NativeSession>();
  for (const result of await Promise.allSettled(handles)) {
    if (result.status !== 'fulfilled' || result.value.observers.signal.aborted) continue;
    const session = result.value.session, threadId = session.thread.getId();
    if (threadId) mounted.set(threadId, session);
  }
  return chats.map(chat => ({ ...chat, isRunning: mounted.get(chat.id)?.displayState.get().isRunning ?? false }));
}
