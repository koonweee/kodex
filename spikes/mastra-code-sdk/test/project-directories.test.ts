import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listProjectDirectories } from '../src/project-directories.js';

test('project chooser lists immediate canonical directories and bounds parent navigation to home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-directories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Zeta'));
  await mkdir(join(root, 'Alpha', 'nested'), { recursive: true });
  await writeFile(join(root, 'file'), 'not a directory');
  const home = await realpath(root);
  const listing = await listProjectDirectories({ home });
  assert.deepEqual(listing, { path: home, homePath: home, parentPath: null, directories: [
    { name: 'Alpha', path: join(home, 'Alpha') }, { name: 'Zeta', path: join(home, 'Zeta') },
  ] });
  const child = await listProjectDirectories({ home, path: join(home, 'Alpha') });
  assert.equal(child.parentPath, home);
  assert.deepEqual(child.directories, [{ name: 'nested', path: join(home, 'Alpha', 'nested') }]);
});

test('project chooser rejects traversal, missing paths and files; excludes escaping and dangling links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-directories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  await mkdir(join(home, 'inside'));
  await writeFile(join(home, 'file'), 'not a directory');
  await symlink(root, join(home, 'escape'));
  await symlink(join(home, 'inside'), join(home, 'alias'));
  await symlink(join(root, 'missing'), join(home, 'dangling'));
  for (const path of [root, join(home, '..'), 'relative', join(home, 'file'), join(home, 'escape')]) {
    await assert.rejects(listProjectDirectories({ home, path }), { code: 'BAD_REQUEST' });
  }
  await assert.rejects(listProjectDirectories({ home, path: join(home, 'missing') }), { code: 'NOT_FOUND' });
  assert.deepEqual((await listProjectDirectories({ home })).directories.map(entry => entry.name), ['alias', 'inside']);
});
