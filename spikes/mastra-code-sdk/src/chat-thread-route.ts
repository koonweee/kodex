import { collectChatDescendants } from './chat-descendants.js';
import type { NativeThread } from './chat-projects.js';
import { isChildThread, readChildRelation } from './child-relation.js';
import type { RuntimeBinding } from './product-registry.js';

export const ownsThread = (binding: RuntimeBinding, thread: NativeThread) => thread.metadata?.projectPath === binding.cwd && thread.metadata?.forkedSubagent !== true && !isChildThread(thread.metadata);

export interface ChatThreadRoute {
  kind: 'ordinary' | 'fork' | 'child';
  thread: NativeThread;
  root: NativeThread;
  /** Root through immediate parent; empty for an ordinary chat. */
  ancestors: NativeThread[];
}
function nativeKind(thread: NativeThread): ChatThreadRoute['kind'] | null {
  if (!thread.id || typeof thread.resourceId !== 'string' || !thread.resourceId) return null;
  const fork = thread.metadata?.forkedSubagent;
  if (fork !== undefined && fork !== false && fork !== true) return null;
  if (isChildThread(thread.metadata)) return fork === true || !readChildRelation(thread.metadata) ? null : 'child';
  return fork === true ? 'fork' : 'ordinary';
}

/** Resolve native lineage only; the caller fences registry archive/membership
 * reads and supplies the runtime belonging to this immutable binding.
 */
export function resolveChatThreadRoute(binding: RuntimeBinding, rows: NativeThread[], threadId: string): ChatThreadRoute | null {
  const byId = new Map<string, NativeThread>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (byId.has(row.id)) ambiguous.add(row.id);
    else byId.set(row.id, row);
  }
  const thread = byId.get(threadId);
  if (!thread) return null;
  const path = [thread], visited = new Set<string>();
  let current = thread;
  for (;;) {
    if (ambiguous.has(current.id) || visited.has(current.id)) return null;
    visited.add(current.id);
    const kind = nativeKind(current);
    if (!kind) return null;
    if (kind === 'ordinary') {
      if (!ownsThread(binding, current)) return null;
      path.reverse();
      if (current.id === thread.id) return { kind, thread, root: current, ancestors: [] };
      // Reuse the shared spawn-edge contract, including native forks with no
      // explicit projectPath and fresh children with their distinct resources.
      const descendant = collectChatDescendants(current, path, binding.cwd).find(row => row.thread.id === thread.id);
      return descendant ? { kind: descendant.kind, thread, root: current, ancestors: path.slice(0, -1) } : null;
    }
    const parentId = current.metadata?.parentThreadId;
    if (typeof parentId !== 'string' || !parentId) return null;
    const parent = byId.get(parentId);
    if (!parent) return null;
    path.push(parent); current = parent;
  }
}
