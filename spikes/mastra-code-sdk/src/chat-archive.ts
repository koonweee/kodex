import { ORPCError } from '@orpc/server';
import type { NativeSession } from './runtime.js';

/** Stop the selected native conversation, including extension-owned signals.
 * Keep storage open: Session retirement is not a persistence-flush guarantee.
 */
export async function abortNativeChat(session: NativeSession): Promise<void> {
  const agent = session.machinery.getAgent();
  agent.abortThreadStream({ resourceId: session.identity.getResourceId(), threadId: session.thread.requireId(), clearPendingSignals: true });
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
