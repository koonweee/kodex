#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Publish into a stable directory outside build output. Retain hashed assets for
 * existing tabs; replace each mutable file atomically, with index.html before the service worker. */
export async function publishFrontend(source, destination, commit) {
  const index = await readFile(join(source, 'index.html'));
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Deployment directory must not be a symlink.');
  for (const name of await readdir(source)) {
    if (name === 'index.html' || name === 'sw.js') continue;
    const input = join(source, name);
    const output = join(destination, name);
    if ((await lstat(input)).isDirectory()) await cp(input, output, { recursive: true });
    else {
      const temporary = `${output}.${randomUUID()}.tmp`;
      await cp(input, temporary);
      await rename(temporary, output);
    }
  }
  const revision = createHash('sha256').update(index).digest('hex');
  await writeFile(join(destination, 'kodex-deployment.json'), JSON.stringify({ backend: 'mastra', commit, revision }) + '\n');
  const temporary = join(destination, `.index-${randomUUID()}.tmp`);
  await writeFile(temporary, index);
  await rename(temporary, join(destination, 'index.html'));
  // The new worker precaches index.html: publish it only after the new index.
  const worker = join(source, 'sw.js');
  try { await lstat(worker); } catch (error) { if (error.code === 'ENOENT') return revision; throw error; }
  const workerTemporary = join(destination, `.sw-${randomUUID()}.tmp`);
  await cp(worker, workerTemporary);
  await rename(workerTemporary, join(destination, 'sw.js'));
  return revision;
}

async function main() {
  const { values } = parseArgs({ options: {
    profile: { type: 'string', default: process.env.KODEX_MASTRA_PROFILE ?? join(homedir(), '.kodex', 'mastra-spike') },
    url: { type: 'string', default: 'http://127.0.0.1:8789' },
  } });
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const profile = await realpath(values.profile);
  const marker = JSON.parse(await readFile(join(profile, '.kodex-mastra-spike.json'), 'utf8'));
  if (marker.kind !== 'kodex-mastra-code-sdk-spike' || marker.version !== 1) throw new Error('Select an initialized dedicated Mastra profile.');
  const lock = join(profile, '.frontend-deploy-lock');
  await mkdir(lock); // Fail rather than race another deployment.
  let temporary;
  try {
    temporary = await mkdtemp(join(tmpdir(), 'kodex-mastra-frontend-'));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const archive = join(temporary, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], { cwd: repo });
    execFileSync('tar', ['-xf', archive, '-C', temporary]);
    for (const path of ['apps/web', 'spikes/mastra-code-sdk']) {
      await symlink(await realpath(join(repo, path, 'node_modules')), join(temporary, path, 'node_modules'), 'dir');
    }
    console.log(`Building committed ${commit}; uncommitted edits are not deployed.`);
    const web = join(temporary, 'apps/web');
    execFileSync('npm', ['run', 'build'], { cwd: web, stdio: 'inherit', env: { ...process.env, VITE_KODEX_BACKEND: 'mastra', VITE_KODEX_API_BASE_URL: '' } });
    const destination = join(profile, 'frontend');
    const revision = await publishFrontend(join(web, 'dist'), destination, commit);
    console.log(`Deployed Mastra frontend: ${destination}`);
    console.log(`Serve with KODEX_FRONTEND_DIST=${destination}`);
    // Notification failure does not undo a successful publication. Reconnect also checks updates.
    try {
      const require = createRequire(join(repo, 'spikes/mastra-code-sdk/package.json'));
      const { createORPCClient } = require('@orpc/client');
      const { RPCLink } = require('@orpc/client/fetch');
      const client = createORPCClient(new RPCLink({ url: `${values.url.replace(/\/$/, '')}/rpc` }));
      await client.frontendUpdated({ revision }, { signal: AbortSignal.timeout(5000) });
    } catch { console.warn('Assets deployed; could not notify the backend. Check its URL and served directory.'); }
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
