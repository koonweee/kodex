import { createClient, type Row } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SpikeProfile } from './profile.js';

export interface PushDeviceInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
}
export interface PushDevice {
  id: string; endpoint: string; userAgent: string | null; enabled: boolean; createdAt: string; updatedAt: string;
}
export interface StoredPushDevice extends PushDevice { keys: PushDeviceInput['keys'] }
export interface PushTerminalEvent {
  bindingId: string; threadId: string; runId: string; reason: 'complete' | 'aborted' | 'error';
}
export interface PushDelivery {
  id: string; event: PushTerminalEvent | null; attempts: number; deliveredIds: string[];
}
const device = (row: Row): StoredPushDevice => ({
  id: String(row.id), endpoint: String(row.endpoint), userAgent: row.user_agent === null ? null : String(row.user_agent),
  enabled: Boolean(row.enabled), createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(),
  keys: { p256dh: String(row.p256dh), auth: String(row.auth) },
});
export function publicPushDevice({ keys: _keys, ...value }: StoredPushDevice): PushDevice { return value; }
const delivery = (row: Row): PushDelivery => ({ id: String(row.id), event: row.event_json === null ? null : JSON.parse(String(row.event_json)),
  attempts: Number(row.attempts), deliveredIds: JSON.parse(String(row.delivered_ids)) });

/** A delivery outbox only: these rows never reconstruct native runs or read state. One owner per profile. */
export async function openPushStore(profile: SpikeProfile) {
  await mkdir(profile.appDataDir, { recursive: true, mode: 0o700 });
  const path = join(profile.appDataDir, 'push.db');
  const db = createClient({ url: pathToFileURL(path).href });
  try {
    await db.executeMultiple(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        user_agent TEXT, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, event_key TEXT UNIQUE, event_json TEXT, status TEXT NOT NULL,
        available_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, delivered_ids TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS due_deliveries ON deliveries(status,available_at);
      UPDATE deliveries SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END WHERE status='processing';`);
    await chmod(path, 0o600);
  } catch (error) { db.close(); throw error; }
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Push store is closed.'));
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  return {
    upsert(input: PushDeviceInput, now: number) { return serialized(async () => {
      const result = await db.execute({ sql: `INSERT INTO subscriptions(id,endpoint,p256dh,auth,user_agent,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,
        user_agent=excluded.user_agent,enabled=1,updated_at=excluded.updated_at RETURNING *`,
        args: [randomUUID(), input.endpoint, input.keys.p256dh, input.keys.auth, input.userAgent ?? null, now, now] });
      return device(result.rows[0]!);
    }); },
    current(endpoint: string) { return serialized(async () => {
      const result = await db.execute({ sql: 'SELECT * FROM subscriptions WHERE endpoint=?', args: [endpoint] });
      return result.rows[0] ? device(result.rows[0]) : null;
    }); },
    enabled() { return serialized(async () => (await db.execute('SELECT * FROM subscriptions WHERE enabled=1 ORDER BY created_at,id')).rows.map(device)); },
    disable(endpoint: string, now: number) { return serialized(async () => {
      const result = await db.execute({ sql: 'UPDATE subscriptions SET enabled=0,updated_at=? WHERE endpoint=? RETURNING *', args: [now, endpoint] });
      return result.rows[0] ? device(result.rows[0]) : null;
    }); },
    remove(id: string) { return serialized(async () => {
      const result = await db.execute({ sql: 'DELETE FROM subscriptions WHERE id=? RETURNING *', args: [id] });
      return result.rows[0] ? device(result.rows[0]) : null;
    }); },
    enqueue(event: PushTerminalEvent | null, availableAt: number) { return serialized(async () => {
      const key = event ? JSON.stringify([event.bindingId, event.threadId, event.runId]) : null;
      const id = randomUUID();
      await db.execute({ sql: 'INSERT INTO deliveries(id,event_key,event_json,status,available_at) VALUES(?,?,?,\'pending\',?) ON CONFLICT(event_key) DO NOTHING',
        args: [id, key, event ? JSON.stringify(event) : null, availableAt] });
      if (key === null) return id;
      return String((await db.execute({ sql: 'SELECT id FROM deliveries WHERE event_key=?', args: [key] })).rows[0]!.id);
    }); },
    claim(now: number) { return serialized(async () => {
      const result = await db.execute({ sql: `UPDATE deliveries SET status='processing',attempts=attempts+1 WHERE id=(
        SELECT id FROM deliveries WHERE status='pending' AND available_at<=? ORDER BY available_at,id LIMIT 1) RETURNING *`, args: [now] });
      return result.rows[0] ? delivery(result.rows[0]) : null;
    }); },
    recordDelivered(job: PushDelivery, id: string) { return serialized(async () => {
      if (!job.deliveredIds.includes(id)) job.deliveredIds.push(id);
      await db.execute({ sql: 'UPDATE deliveries SET delivered_ids=? WHERE id=?', args: [JSON.stringify(job.deliveredIds), job.id] });
    }); },
    finish(id: string, status: 'sent' | 'skipped' | 'failed' | 'pending', availableAt: number) { return serialized(async () => {
      await db.execute({ sql: 'UPDATE deliveries SET status=?,available_at=? WHERE id=?', args: [status, availableAt, id] });
    }); },
    async close() { if (!closed) { closed = true; await tail; db.close(); } },
  };
}
