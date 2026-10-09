import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishFrontend } from './mastra-frontend.mjs';

test('published frontend survives ordinary build replacement and keeps older hashed assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mastra-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'build'); const destination = join(root, 'profile', 'frontend');
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'index.html'), 'native-v1');
  await writeFile(join(source, 'assets', 'old.js'), 'old');
  await publishFrontend(source, destination, 'commit-one');
  await rm(source, { recursive: true });
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'index.html'), 'ordinary-app-server-build');
  assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), 'native-v1');
  await writeFile(join(source, 'index.html'), 'native-v2');
  await writeFile(join(source, 'assets', 'new.js'), 'new');
  await publishFrontend(source, destination, 'commit-two');
  assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), 'native-v2');
  assert.equal(await readFile(join(destination, 'assets', 'old.js'), 'utf8'), 'old');
  assert.equal(await readFile(join(destination, 'assets', 'new.js'), 'utf8'), 'new');
});

test('an incomplete build leaves the published index untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mastra-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'live'));
  await writeFile(join(root, 'live', 'index.html'), 'working');
  await assert.rejects(publishFrontend(join(root, 'missing'), join(root, 'live'), 'bad'));
  assert.equal(await readFile(join(root, 'live', 'index.html'), 'utf8'), 'working');
});

test('failed index publication cannot advertise a new precaching service worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mastra-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'build'); const destination = join(root, 'live');
  await mkdir(source); await mkdir(join(destination, 'index.html'), { recursive: true });
  await writeFile(join(source, 'index.html'), 'new-index');
  await writeFile(join(source, 'sw.js'), 'new-worker');
  await writeFile(join(destination, 'sw.js'), 'old-worker');
  await assert.rejects(publishFrontend(source, destination, 'new'));
  assert.equal(await readFile(join(destination, 'sw.js'), 'utf8'), 'old-worker');
});
