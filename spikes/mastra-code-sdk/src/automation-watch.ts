import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

/** Native workers write without a public post-persistence notification. Read
 * serialized full snapshots while observed; this never schedules agent work.
 * Epochs belong to subscriptions, so unrelated overlapping reads cannot claim
 * a shared ordering or overwrite a newer snapshot in the same subscription. */
export async function* watchAutomationState<T>(read: () => Promise<T[]>, signal?: AbortSignal, intervalMs = 1000) {
  const epoch = randomUUID();
  let revision = 0, previous: string | undefined;
  while (!signal?.aborted) {
    const rows = await read();
    if (signal?.aborted) return;
    const serialized = JSON.stringify(rows);
    if (serialized !== previous) {
      previous = serialized;
      yield { epoch, revision: ++revision, rows };
    }
    try { await setTimeout(intervalMs, undefined, { signal }); }
    catch (error) { if (signal?.aborted) return; throw error; }
  }
}
