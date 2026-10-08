import { createChatPresence } from './chat-presence.js';
import type { createChatActivity } from './chat-activity.js';
import type { ChatReadState } from './chat-read-state.js';
import type { createChatProjects } from './chat-projects.js';
import type { CatalogSnapshot } from './chat-service-types.js';

export type UnreadBadge = { epoch: string; revision: number; count: number | null };

/** Canonical catalog reads and browser transport projections share one coverage
 * fence. Neither presence nor badges activate Sessions or recover terminal heads. */
export function createChatNotifications(options: {
  epoch: string;
  revision: () => number;
  inventory: ReturnType<typeof createChatProjects>['inventory'];
  projectActivity: ReturnType<typeof createChatActivity>['project'];
  readState: (bindingId: string, threadId: string) => ChatReadState;
  signal: AbortSignal;
  assertActive: () => void;
  resolveVisible: Parameters<typeof createChatPresence>[0]['resolveVisible'];
}) {
  const presence = createChatPresence({ resolveVisible: options.resolveVisible });
  async function catalogSnapshot(signal?: AbortSignal): Promise<CatalogSnapshot> {
    for (;;) {
      signal?.throwIfAborted(); options.signal.throwIfAborted(); options.assertActive();
      const revision = options.revision();
      const inventory = await options.inventory();
      const chats = options.projectActivity(inventory.chats).map(chat => ({ ...chat, readState: options.readState(chat.bindingId, chat.id) }));
      const pinnedDescendants = options.projectActivity(inventory.pinnedDescendants).map(chat => ({ ...chat, readState: options.readState(chat.bindingId, chat.id) }));
      signal?.throwIfAborted(); options.signal.throwIfAborted(); options.assertActive();
      if (revision === options.revision()) return { epoch: options.epoch, revision, ...inventory, chats, pinnedDescendants };
    }
  }
  return {
    catalogSnapshot,
    replaceChatPresence: presence.replace,
    async getUnreadBadge(signal?: AbortSignal): Promise<UnreadBadge> {
      const snapshot = await catalogSnapshot(signal);
      // Catalog chats are the full ordinary inventory; pins do not add native
      // descendants to the count. Unknown is not a zero or a recovered head.
      const unknown = snapshot.chats.some(chat => chat.readState.epoch !== snapshot.epoch || !chat.readState.head || chat.readState.seen === null);
      return { epoch: snapshot.epoch, revision: snapshot.revision,
        count: unknown ? null : snapshot.chats.filter(chat => chat.readState.seen === false).length };
    },
    forget: presence.forget,
    dispose: presence.dispose,
  };
}
