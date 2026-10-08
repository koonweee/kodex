import { ORPCError } from '@orpc/server';
import type { NativeSession, ProjectRuntime } from './runtime.js';
import type { NativeThread } from './chat-projects.js';
import { readChatDescendants } from './chat-descendants.js';

/** Stop the selected native conversation, including extension-owned signals.
 * Keep storage open: Session retirement is not a persistence-flush guarantee.
 */
export async function abortNativeChat(session: NativeSession): Promise<void> {
  const agent = session.machinery.getAgent();
  const threadId = session.thread.getId();
  if (threadId) agent.abortThreadStream({ resourceId: session.identity.getResourceId(), threadId, clearPendingSignals: true });
  session.abort();
  const deadline = AbortSignal.timeout(15_000);
  // Public native teardown notifications can resolve separately. Register both
  // before yielding and recheck their state; neither observation alone is idle.
  while (session.stream.isActive() || session.run.getRunId() !== null) {
    if (deadline.aborted) throw new ORPCError('CONFLICT', { message: 'The native chat is still stopping. Retry archive.' });
    const waiting = new AbortController();
    const signal = AbortSignal.any([deadline, waiting.signal]);
    try { await Promise.race([session.stream.waitForTeardown(signal), session.run.waitForTeardown(signal)]); }
    finally { waiting.abort(); }
  }
}

/** Call after retiring the root binding: native cancellation must not wake the
 * archived parent. A task admitted before retirement remains in native storage,
 * even if its child Session has not been created yet.
 */
export async function retireChatDescendants(runtime: ProjectRuntime, parent: NativeThread, projectPath: string): Promise<string[]> {
  const descendants = await readChatDescendants({ runtime, parent, projectPath });
  const manager = runtime.mastra.backgroundTaskManager;
  for (const owner of [parent, ...descendants.map(row => row.thread)]) {
    if (owner.id !== parent.id) {
      const session = await runtime.controller.getSessionByResource(owner.resourceId);
      const mountedThread = session?.thread.getId();
      if (!mountedThread || mountedThread === owner.id) {
        if (session) await abortNativeChat(session);
        // Also join a task finalizer that already removed its registration.
        await runtime.releaseSession({ resourceId: owner.resourceId });
      }
    }
    if (manager) {
      // No perPage: the pinned native adapter returns the full matching set.
      const tasks = await manager.listTasks({ threadId: owner.id, resourceId: owner.resourceId, status: ['pending', 'running', 'suspended'] });
      for (const task of tasks.tasks) await manager.cancel(task.id);
    }
  }
  return descendants.map(row => row.thread.id);
}
