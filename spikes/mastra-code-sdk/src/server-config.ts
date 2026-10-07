import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SpikeProfile } from './profile.js';

/** CLI startup seeds only. The durable product registry owns current project metadata. */
export async function loadServerConfig(profile: SpikeProfile, paths: string[]) {
  const projects = await Promise.all(paths.map(async path => {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Project path must be a directory.');
    const id = createHash('sha256').update(canonical).digest('hex');
    return { id, name: basename(canonical), path: canonical, runtimeRoot: join(profile.appDataDir, 'projects', id) };
  }));
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw new Error('Duplicate project directories.');
  const identityPath = join(profile.root, 'instance-id');
  try { await writeFile(identityPath, randomUUID() + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const instanceId = (await readFile(identityPath, 'utf8')).trim();
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(instanceId)) throw new Error('Invalid persisted server identity.');
  return { instanceId, projects };
}
