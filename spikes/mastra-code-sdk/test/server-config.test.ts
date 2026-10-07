import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveProfile } from '../src/profile.js';
import { loadServerConfig } from '../src/server-config.js';

test('server identity and project storage survive restart and project order changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-server-config-'));
  try {
    const profile = resolveProfile(join(root, 'profile'));
    await mkdir(profile.root);
    const firstPath = join(root, 'first');
    const secondPath = join(root, 'second');
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    const first = await loadServerConfig(profile, [firstPath, secondPath]);
    const restarted = await loadServerConfig(profile, [secondPath, firstPath]);
    assert.equal(restarted.instanceId, first.instanceId);
    assert.deepEqual(restarted.projects.toReversed(), first.projects);
    assert.notEqual(first.projects[0]?.runtimeRoot, first.projects[1]?.runtimeRoot);
    assert.equal(first.projects[0]?.path, await realpath(firstPath));
    assert.equal(first.projects[0]?.name, 'first');
    await assert.rejects(loadServerConfig(profile, [firstPath, firstPath]), /duplicate/i);
    await assert.rejects(loadServerConfig(profile, [join(root, 'missing')]), /ENOENT/);
    await writeFile(join(root, 'file'), 'not a directory');
    await assert.rejects(loadServerConfig(profile, [join(root, 'file')]), /directory/);
    await writeFile(join(profile.root, 'instance-id'), 'broken');
    await assert.rejects(loadServerConfig(profile, [firstPath]), /identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
