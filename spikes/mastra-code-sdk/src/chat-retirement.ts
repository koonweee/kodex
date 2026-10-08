import { readChatDescendants } from './chat-descendants.js';
import { retireChatDescendants, retireNativeThread } from './chat-archive.js';
import type { createChatProjects } from './chat-projects.js';
import type { createChatLifecycle } from './chat-lifecycle.js';

interface RetiringHandle {
  observers: AbortController;
  queue: { dispose(): void };
  unsubscribe(): void;
  projection: { dispose(): void };
}

/** Ancestor admission protects the short retirement command, not model work.
 * Closing the selected node also fences every descendant's admission chain. */
export function createChatRetirement(options: {
  projects: ReturnType<typeof createChatProjects>;
  lifecycle: ReturnType<typeof createChatLifecycle>;
  handles: Map<string, Promise<RetiringHandle>>;
  changed(chatId: string, bindingId: string, retiredIds: string[]): void;
}) {
  return async (chatId: string) => {
    const route = await options.projects.resolveThreadRoute(chatId, true);
    return options.lifecycle.admitMany(route.ancestors.map(row => row.id), () => options.lifecycle.retire(chatId, async () => {
      const { binding, runtime, thread } = route;
      // A validated fork can omit projectPath; its ancestry supplies the path.
      const parent = { ...thread, metadata: { ...thread.metadata, projectPath: binding.cwd } };
      const descendants = await readChatDescendants({ runtime, parent, projectPath: binding.cwd });
      for (const id of [chatId, ...descendants.map(row => row.thread.id)]) {
        const key = `${binding.id}:${id}`, handle = await options.handles.get(key);
        handle?.observers.abort();
        handle?.queue.dispose();
        handle?.unsubscribe();
        handle?.projection.dispose();
        options.handles.delete(key);
      }
      // Retire parent before task cancellation can wake it. Preserve unrelated
      // same-resource scopes, including the parent of a directly archived fork.
      await retireNativeThread(runtime, thread);
      const descendantThreadIds = await retireChatDescendants(runtime, parent, binding.cwd);
      await options.projects.archiveChat(binding.id, thread.id, descendantThreadIds);
      options.changed(chatId, binding.id, [chatId, ...descendantThreadIds]);
    }));
  };
}
