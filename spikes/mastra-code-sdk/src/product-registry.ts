import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Row, type Transaction } from '@libsql/client';
import type { SpikeProfile } from './profile.js';

export interface ProductProject { id: string; name: string; roots: string[] }
export interface RuntimeBinding { id: string; projectId: string | null; cwd: string; runtimeRoot: string }
export interface ChatIdentity { bindingId: string; threadId: string }
export interface ChatMetadata extends ChatIdentity { pinPosition: number | null; notificationsEnabled: boolean; archived: boolean }
export interface ChatMetadataSnapshot { revision: number; entries: ChatMetadata[] }
export interface ProjectRegistrySnapshot { revision: number; projects: ProductProject[] }
export interface ProjectSeed { id: string; name: string; path: string; runtimeRoot: string }
export interface ProjectPatch { name?: string; roots?: string[] }
export class ProductRegistryError extends Error {
  constructor(readonly code: 'CONFLICT' | 'NOT_FOUND' | 'INVALID_PROJECT_ROOTS' | 'INVALID_INPUT', message: string) {
    super(message); this.name = 'ProductRegistryError';
  }
}
const invalid = () => new ProductRegistryError('INVALID_INPUT', 'Invalid product metadata.');
const missing = () => new ProductRegistryError('NOT_FOUND', 'Project not found.');
function text(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw invalid();
  return value.trim();
}
function roots(value: string[]): string[] {
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw invalid();
  const normalized = value.map(path => resolve(path));
  if (new Set(normalized).size !== normalized.length) throw invalid();
  return normalized;
}
function project(row: Row): ProductProject {
  return { id: String(row.id), name: String(row.name), roots: JSON.parse(String(row.roots_json)) as string[] };
}
function binding(row: Row): RuntimeBinding {
  return { id: String(row.id), projectId: row.project_id === null ? null : String(row.project_id), cwd: String(row.cwd), runtimeRoot: String(row.runtime_root) };
}

function chatMetadata(row: Row): ChatMetadata {
  return { bindingId: String(row.binding_id), threadId: String(row.thread_id), pinPosition: row.pin_position === null ? null : Number(row.pin_position), notificationsEnabled: Number(row.notifications_enabled) !== 0, archived: Number(row.archived) !== 0 };
}
const sameChat = (left: ChatIdentity, right: ChatIdentity) => left.bindingId === right.bindingId && left.threadId === right.threadId;

// Local libSQL writes begin synchronously. Serialize transactions for one file
// across registry handles so another handle cannot block its own process's writer.
// SQLite transactions remain the cross-process mutation boundary.
const gates = new Map<string, Promise<void>>();
async function withFileGate<T>(path: string, run: () => Promise<T>): Promise<T> {
  const before = gates.get(path) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(done => { release = done; });
  const tail = before.then(() => turn);
  gates.set(path, tail);
  await before;
  try { return await run(); }
  finally { release(); if (gates.get(path) === tail) gates.delete(path); }
}

/** Product metadata only. Native databases, transcripts and queues are never
 * opened or moved here. Returned bindings may be mounted after transactions end.
 */
export async function openProductRegistry(profile: SpikeProfile, options: { standaloneCwd?: string } = {}) {
  const databasePath = join(profile.appDataDir, 'kodex.db');
  const standaloneCwd = resolve(options.standaloneCwd ?? homedir());
  await mkdir(profile.appDataDir, { recursive: true, mode: 0o700 });
  const db = createClient({ url: pathToFileURL(databasePath).href });
  try {
    await withFileGate(databasePath, async () => {
      await db.execute('PRAGMA journal_mode=WAL');
      await db.batch([
        `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, roots_json TEXT NOT NULL, position INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS runtime_bindings (id TEXT PRIMARY KEY, project_id TEXT, cwd TEXT NOT NULL, runtime_root TEXT NOT NULL UNIQUE)`,
        `CREATE TABLE IF NOT EXISTS chat_metadata (binding_id TEXT NOT NULL, thread_id TEXT NOT NULL, pin_position INTEGER, notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)), archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), PRIMARY KEY (binding_id, thread_id))`,
        `CREATE TABLE IF NOT EXISTS project_seeds (id TEXT PRIMARY KEY)`,
        `CREATE TABLE IF NOT EXISTS project_creates (create_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS registry_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, standalone_binding_id TEXT)`,
        `INSERT OR IGNORE INTO registry_state (id, revision) VALUES (1, 0)`,
      ], 'write');
      const columns = (await db.execute('PRAGMA table_info(chat_metadata)')).rows;
      if (!columns.some(row => row.name === 'archived')) await db.execute('ALTER TABLE chat_metadata ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))');
    });
  } catch (error) { db.close(); throw error; }
  let closing = false;
  let closed: Promise<void> | undefined;
  async function transaction<T>(mode: 'read' | 'write', run: (tx: Transaction) => Promise<T>): Promise<T> {
    if (closing) throw new Error('The product registry is closed.');
    return withFileGate(databasePath, async () => {
      const tx = await db.transaction(mode);
      try { const result = await run(tx); await tx.commit(); return result; }
      catch (error) { await tx.rollback(); throw error; }
      finally { tx.close(); }
    });
  }
  const getProject = async (tx: Transaction, id: string) => {
    const row = (await tx.execute({ sql: 'SELECT * FROM projects WHERE id = ?', args: [id] })).rows[0];
    if (!row) throw missing();
    return project(row);
  };
  async function validChatIdentity(tx: Transaction, input: ChatIdentity) {
    const identity = { bindingId: text(input.bindingId), threadId: text(input.threadId) };
    if (!(await tx.execute({ sql: 'SELECT id FROM runtime_bindings WHERE id = ?', args: [identity.bindingId] })).rows.length) throw missing();
    return identity;
  }
  const changed = async (tx: Transaction) => { await tx.execute('UPDATE registry_state SET revision = revision + 1 WHERE id = 1'); };
  const nextPosition = async (tx: Transaction) => Number((await tx.execute('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM projects')).rows[0]!.position);
  async function insertBinding(tx: Transaction, projectId: string | null, cwd: string, runtimeRoot?: string) {
    const id = randomUUID();
    const value: RuntimeBinding = { id, projectId, cwd, runtimeRoot: runtimeRoot ?? join(profile.appDataDir, 'runtimes', id) };
    await tx.execute({ sql: 'INSERT INTO runtime_bindings (id, project_id, cwd, runtime_root) VALUES (?, ?, ?, ?)', args: [id, projectId, cwd, value.runtimeRoot] });
    return value;
  }

  return {
    async snapshot(): Promise<ProjectRegistrySnapshot> {
      return transaction('read', async tx => {
        const revision = Number((await tx.execute('SELECT revision FROM registry_state WHERE id = 1')).rows[0]!.revision);
        const projects = (await tx.execute('SELECT * FROM projects ORDER BY position, id')).rows.map(project);
        return { revision, projects };
      });
    },
    async listBindings(): Promise<RuntimeBinding[]> {
      return transaction('read', async tx => (await tx.execute('SELECT * FROM runtime_bindings ORDER BY rowid')).rows.map(binding));
    },
    async chatMetadataSnapshot(): Promise<ChatMetadataSnapshot> {
      return transaction('read', async tx => {
        const revision = Number((await tx.execute('SELECT revision FROM registry_state WHERE id = 1')).rows[0]!.revision);
        const entries = (await tx.execute('SELECT * FROM chat_metadata ORDER BY pin_position IS NULL, pin_position, binding_id, thread_id')).rows.map(chatMetadata);
        return { revision, entries };
      });
    },
    async archiveChat(input: ChatIdentity): Promise<void> {
      await transaction('write', async tx => {
        const { bindingId, threadId } = await validChatIdentity(tx, input);
        const current = (await tx.execute({ sql: 'SELECT archived FROM chat_metadata WHERE binding_id = ? AND thread_id = ?', args: [bindingId, threadId] })).rows[0];
        if (current && Number(current.archived) !== 0) return;
        await tx.execute({ sql: `INSERT INTO chat_metadata (binding_id, thread_id, archived) VALUES (?, ?, 1)
          ON CONFLICT (binding_id, thread_id) DO UPDATE SET archived = 1`, args: [bindingId, threadId] });
        await changed(tx);
      });
    },
    async setChatNotifications(input: ChatIdentity & { enabled: boolean }): Promise<void> {
      if (typeof input.enabled !== 'boolean') throw invalid();
      await transaction('write', async tx => {
        const { bindingId, threadId } = await validChatIdentity(tx, input);
        const current = (await tx.execute({ sql: 'SELECT notifications_enabled FROM chat_metadata WHERE binding_id = ? AND thread_id = ?', args: [bindingId, threadId] })).rows[0];
        if ((current ? Number(current.notifications_enabled) !== 0 : true) === input.enabled) return;
        await tx.execute({ sql: `INSERT INTO chat_metadata (binding_id, thread_id, notifications_enabled) VALUES (?, ?, ?)
          ON CONFLICT (binding_id, thread_id) DO UPDATE SET notifications_enabled = excluded.notifications_enabled`, args: [bindingId, threadId, input.enabled ? 1 : 0] });
        await changed(tx);
      });
    },
    async setChatPinned(input: ChatIdentity & { pinned: boolean; before?: ChatIdentity | null }): Promise<void> {
      const hasBefore = Object.hasOwn(input, 'before');
      if (typeof input.pinned !== 'boolean' || (!input.pinned && hasBefore) || (hasBefore && input.before === undefined)) throw invalid();
      await transaction('write', async tx => {
        const identity = await validChatIdentity(tx, input);
        const pinned = (await tx.execute('SELECT * FROM chat_metadata WHERE pin_position IS NOT NULL ORDER BY pin_position, binding_id, thread_id')).rows.map(chatMetadata);
        const current = pinned.findIndex(row => sameChat(row, identity));
        if (!input.pinned) {
          if (current < 0) return;
          await tx.execute({ sql: 'UPDATE chat_metadata SET pin_position = NULL WHERE binding_id = ? AND thread_id = ?', args: [identity.bindingId, identity.threadId] });
          await changed(tx);
          return;
        }
        if (current >= 0 && !hasBefore) return; // Repeat Pin must not reorder.
        const next: ChatIdentity[] = pinned.filter(row => !sameChat(row, identity));
        let position = next.length;
        if (input.before !== undefined && input.before !== null) {
          const before = { bindingId: text(input.before.bindingId), threadId: text(input.before.threadId) };
          if (sameChat(before, identity) && current >= 0) return;
          position = next.findIndex(row => sameChat(row, before));
          if (position < 0) throw new ProductRegistryError('CONFLICT', 'The target chat is not pinned.');
        }
        next.splice(position, 0, identity);
        if (next.length === pinned.length && next.every((row, index) => sameChat(row, pinned[index]!))) return;
        for (const [pinPosition, row] of next.entries()) {
          await tx.execute({ sql: `INSERT INTO chat_metadata (binding_id, thread_id, pin_position) VALUES (?, ?, ?)
            ON CONFLICT (binding_id, thread_id) DO UPDATE SET pin_position = excluded.pin_position`, args: [row.bindingId, row.threadId, pinPosition] });
        }
        await changed(tx);
      });
    },
    async seedProjects(seeds: ProjectSeed[]): Promise<void> {
      // CLI seeds are remembered even after deletion. They never update existing
      // metadata or resurrect a deleted project on a later launch.
      const prepared = seeds.map(seed => ({ id: text(seed.id), name: text(seed.name), cwd: roots([seed.path])[0]!, runtimeRoot: roots([seed.runtimeRoot])[0]! }));
      if (new Set(prepared.map(seed => seed.id)).size !== prepared.length) throw invalid();
      await transaction('write', async tx => {
        let inserted = false;
        for (const seed of prepared) {
          if ((await tx.execute({ sql: 'SELECT id FROM project_seeds WHERE id = ?', args: [seed.id] })).rows.length) continue;
          if ((await tx.execute({ sql: 'SELECT id FROM projects WHERE id = ?', args: [seed.id] })).rows.length) throw new ProductRegistryError('CONFLICT', 'Project seed identity already exists.');
          await tx.execute({ sql: 'INSERT INTO projects (id, name, roots_json, position) VALUES (?, ?, ?, ?)', args: [seed.id, seed.name, JSON.stringify([seed.cwd]), await nextPosition(tx)] });
          await insertBinding(tx, seed.id, seed.cwd, seed.runtimeRoot);
          await tx.execute({ sql: 'INSERT INTO project_seeds (id) VALUES (?)', args: [seed.id] });
          inserted = true;
        }
        if (inserted) await changed(tx);
      });
    },
    async createProject(input: { createKey: string; name: string; roots: string[] }): Promise<ProductProject> {
      const key = text(input.createKey);
      const value = { name: text(input.name), roots: roots(input.roots) };
      const fingerprint = JSON.stringify(value);
      return transaction('write', async tx => {
        const previous = (await tx.execute({ sql: 'SELECT * FROM project_creates WHERE create_key = ?', args: [key] })).rows[0];
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ProductRegistryError('CONFLICT', 'Create key was already used for different project metadata.');
          return getProject(tx, String(previous.project_id));
        }
        const created = { id: randomUUID(), ...value };
        await tx.execute({ sql: 'INSERT INTO projects (id, name, roots_json, position) VALUES (?, ?, ?, ?)', args: [created.id, created.name, JSON.stringify(created.roots), await nextPosition(tx)] });
        await tx.execute({ sql: 'INSERT INTO project_creates (create_key, fingerprint, project_id) VALUES (?, ?, ?)', args: [key, fingerprint, created.id] });
        await changed(tx);
        return created;
      });
    },
    async updateProject(input: { id: string; patch: ProjectPatch }): Promise<ProductProject> {
      const id = text(input.id);
      if (!input.patch || Object.keys(input.patch).some(key => key !== 'name' && key !== 'roots')) throw invalid();
      const name = input.patch.name === undefined ? undefined : text(input.patch.name);
      const nextRoots = input.patch.roots === undefined ? undefined : roots(input.patch.roots);
      return transaction('write', async tx => {
        const previous = await getProject(tx, id);
        const value = { ...previous, name: name ?? previous.name, roots: nextRoots ?? previous.roots };
        if (value.name === previous.name && JSON.stringify(value.roots) === JSON.stringify(previous.roots)) return previous;
        await tx.execute({ sql: 'UPDATE projects SET name = ?, roots_json = ? WHERE id = ?', args: [value.name, JSON.stringify(value.roots), id] });
        await changed(tx);
        return value;
      });
    },
    async deleteProject(input: { id: string }): Promise<void> {
      const id = text(input.id);
      await transaction('write', async tx => {
        await getProject(tx, id);
        await tx.execute({ sql: 'UPDATE runtime_bindings SET project_id = NULL WHERE project_id = ?', args: [id] });
        await tx.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [id] });
        await changed(tx);
      });
    },
    async moveProjectBefore(input: { id: string; beforeId: string | null }): Promise<void> {
      const id = text(input.id);
      const beforeId = input.beforeId === null ? null : text(input.beforeId);
      await transaction('write', async tx => {
        const rows = (await tx.execute('SELECT * FROM projects ORDER BY position, id')).rows;
        const ids = rows.map(row => String(row.id));
        if (!ids.includes(id) || (beforeId !== null && !ids.includes(beforeId))) throw missing();
        if (id === beforeId) return;
        const next = ids.filter(value => value !== id);
        next.splice(beforeId === null ? next.length : next.indexOf(beforeId), 0, id);
        if (next.every((value, index) => ids[index] === value)) return;
        for (const [position, moved] of next.entries()) {
          await tx.execute({ sql: 'UPDATE projects SET position = ? WHERE id = ?', args: [position, moved] });
        }
        await changed(tx);
      });
    },
    async executionBinding(projectId: string | null): Promise<RuntimeBinding> {
      if (projectId !== null) text(projectId);
      return transaction('write', async tx => {
        if (projectId === null) {
          const known = (await tx.execute('SELECT standalone_binding_id FROM registry_state WHERE id = 1')).rows[0]!.standalone_binding_id;
          if (known !== null) return binding((await tx.execute({ sql: 'SELECT * FROM runtime_bindings WHERE id = ?', args: [known] })).rows[0]!);
          const created = await insertBinding(tx, null, standaloneCwd);
          await tx.execute({ sql: 'UPDATE registry_state SET standalone_binding_id = ? WHERE id = 1', args: [created.id] });
          await changed(tx);
          return created;
        }
        const current = await getProject(tx, projectId);
        if (current.roots.length !== 1) throw new ProductRegistryError('INVALID_PROJECT_ROOTS', 'Project execution requires exactly one root.');
        const cwd = current.roots[0]!;
        const known = (await tx.execute({ sql: 'SELECT * FROM runtime_bindings WHERE project_id = ? AND cwd = ? ORDER BY rowid LIMIT 1', args: [projectId, cwd] })).rows[0];
        if (known) return binding(known);
        const created = await insertBinding(tx, projectId, cwd);
        await changed(tx);
        return created;
      });
    },
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      closed = withFileGate(databasePath, async () => { db.close(); });
      return closed;
    },
  };
}
export type ProductRegistry = Awaited<ReturnType<typeof openProductRegistry>>;
