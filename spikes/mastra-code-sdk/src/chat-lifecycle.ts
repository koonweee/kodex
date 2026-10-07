import { ORPCError } from '@orpc/server';

/** Per-chat admission leases cover command acceptance and reads, never the model
 * run. Retirement closes admission immediately and drains those short operations
 * before native teardown. Different chats and concurrent native commands remain
 * independent; this is not a turn scheduler.
 */
export function createChatLifecycle() {
  const states = new Map<string, { closed: boolean; active: number; drained?: () => void; retirement?: Promise<void> }>();
  function state(chatId: string) {
    let current = states.get(chatId);
    if (!current) { current = { closed: false, active: 0 }; states.set(chatId, current); }
    return current;
  }
  return {
    async admit<T>(chatId: string, run: () => Promise<T>): Promise<T> {
      const current = state(chatId);
      if (current.closed) throw new ORPCError('CONFLICT', { message: 'This chat is archived or being archived.' });
      current.active++;
      try { return await run(); }
      finally { if (--current.active === 0) current.drained?.(); }
    },
    retire(chatId: string, run: () => Promise<void>): Promise<void> {
      const current = state(chatId);
      if (current.retirement) return current.retirement;
      current.closed = true;
      const drained = current.active === 0 ? Promise.resolve() : new Promise<void>(resolve => { current.drained = resolve; });
      const pending = drained.then(run);
      current.retirement = pending;
      // Failure leaves admissions closed, but permits an explicit archive retry.
      void pending.catch(() => { if (current.retirement === pending) current.retirement = undefined; });
      return pending;
    },
  };
}
