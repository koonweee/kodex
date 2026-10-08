import { readChildRelation } from './child-relation.js';
import type { NativeThread } from './chat-projects.js';
import type { ProjectRuntime } from './runtime.js';

export interface ChatDescendant {
  thread: NativeThread;
  kind: 'fork' | 'child';
  parentThreadId: string;
}
function relationKind(parent: NativeThread, child: NativeThread, projectPath: string): ChatDescendant['kind'] | undefined {
  if (child.id === parent.id) return;
  if (child.resourceId === parent.resourceId && child.metadata?.forkedSubagent === true
    && child.metadata.parentThreadId === parent.id
    // Native agent forks may omit the project path. Their validated ancestor
    // and matching resource own the binding; conflicting explicit paths fail.
    && (child.metadata.projectPath === undefined || child.metadata.projectPath === projectPath)) return 'fork';
  const relation = readChildRelation(child.metadata);
  if (child.resourceId !== parent.resourceId && child.metadata?.projectPath === projectPath
    && child.metadata.forkedSubagent !== true && relation?.parentThreadId === parent.id
    && relation.parentResourceId === parent.resourceId && relation.parentSessionScope === '') return 'child';
}

/** Derive only reachable, validated spawn edges from a native catalog snapshot.
 * Ordinary fork provenance is insufficient. No lineage is stored by the host.
 */
export function collectChatDescendants(parent: NativeThread, rows: NativeThread[], projectPath: string): ChatDescendant[] {
  if (parent.metadata?.projectPath !== projectPath) return [];
  const children = new Map<string, NativeThread[]>();
  for (const row of rows) {
    const parentId = row.metadata?.parentThreadId;
    if (typeof parentId !== 'string') continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(row); children.set(parentId, siblings);
  }
  const visited = new Set([parent.id]), pending = [parent], descendants: ChatDescendant[] = [];
  for (let index = 0; index < pending.length; index++) {
    const ancestor = pending[index]!;
    for (const child of children.get(ancestor.id) ?? []) {
      if (visited.has(child.id)) continue;
      const kind = relationKind(ancestor, child, projectPath);
      if (!kind) continue;
      visited.add(child.id); pending.push(child);
      descendants.push({ thread: child, kind, parentThreadId: ancestor.id });
    }
  }
  return descendants;
}

/** Native catalog reads do not provision Sessions or activate workspaces. Fresh
 * children have distinct resources, so a parent-resource filter would omit them.
 */
export async function readChatDescendants(input: { runtime: ProjectRuntime; parent: NativeThread; projectPath: string }, signal?: AbortSignal): Promise<ChatDescendant[]> {
  signal?.throwIfAborted();
  const rows = await input.runtime.controller.queryThreads({ includeForkedSubagents: true });
  signal?.throwIfAborted();
  return collectChatDescendants(input.parent, rows, input.projectPath);
}
