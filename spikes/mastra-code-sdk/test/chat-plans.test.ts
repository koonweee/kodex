import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ORPCError } from '@orpc/server';
import { getLocalPlansDir, isPlanFilePath, readPlanFile } from '@mastra/code-sdk/utils/plans';
import { readNativePlan, rereadNativePlan } from '../src/chat-plans.js';

async function setup(t: TestContext, factoryProjectId?: string) {
  const root = await mkdtemp(join(tmpdir(), 'kodex-chat-plans-'));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const plansDir = getLocalPlansDir(projectPath, { factoryProjectId }); await mkdir(plansDir, { recursive: true });
  const path = join(plansDir, 'implementation.md');
  const input = { projectPath, submittedPath: relative(projectPath, path), ...(factoryProjectId && { factoryProjectId }) };
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, projectPath, plansDir, path, input };
}
const code = (expected: string) => (error: unknown) => error instanceof ORPCError && error.code === expected;

test('preview uses the native heading/body parser and versions the actual reviewed content', async t => {
  const env = await setup(t);
  await writeFile(env.path, '\n# Native implementation\n\nRead evidence.\n\n- Validate the result.\n');
  const preview = await readNativePlan(env.input);
  assert.equal(preview.path, env.path);
  assert.deepEqual({ title: preview.title, plan: preview.plan }, await readPlanFile(env.path));
  assert.equal(preview.title, 'Native implementation');
  assert.equal(preview.plan, 'Read evidence.\n\n- Validate the result.');
  assert.ok(preview.version);
  assert.deepEqual(await rereadNativePlan(env.input, preview.version), preview);
  assert.deepEqual(await readNativePlan({ ...env.input, submittedPath: env.path }), preview);
});

test('body/title changes conflict even at the same size and timestamp, then a fresh review can proceed', async t => {
  const env = await setup(t);
  const timestamp = new Date('2025-01-01T00:00:00.000Z');
  await writeFile(env.path, '# First\n\nAlpha'); await utimes(env.path, timestamp, timestamp);
  const first = await readNativePlan(env.input);
  await writeFile(env.path, '# First\n\nBravo'); await utimes(env.path, timestamp, timestamp);
  await assert.rejects(rereadNativePlan(env.input, first.version), code('CONFLICT'));
  const changed = await readNativePlan(env.input);
  assert.notEqual(changed.version, first.version); assert.equal(changed.plan, 'Bravo');
  assert.deepEqual(await rereadNativePlan(env.input, changed.version), changed);
  await writeFile(env.path, '# Other\n\nBravo'); await utimes(env.path, timestamp, timestamp);
  await assert.rejects(rereadNativePlan(env.input, changed.version), code('CONFLICT'));
  assert.equal((await readNativePlan(env.input)).title, 'Other');
});

test('native-normalized whitespace, CRLF and identical replacement preserve the reviewed version', async t => {
  const env = await setup(t);
  await writeFile(env.path, '# A plan\n\nSame body.\n');
  const first = await readNativePlan(env.input);
  const replacement = join(env.plansDir, 'replacement.md');
  await writeFile(replacement, '\r\n# A plan   \r\n\r\nSame body.\r\n   \r\n'); await rename(replacement, env.path);
  assert.deepEqual(await rereadNativePlan(env.input, first.version), first);
});

test('factory and ordinary project plan directories follow the SDK scope independently', async t => {
  const env = await setup(t, 'native-factory-project');
  await writeFile(env.path, '# Factory plan\n\nFactory work.');
  const ordinaryDir = getLocalPlansDir(env.projectPath); await mkdir(ordinaryDir, { recursive: true });
  const ordinaryPath = join(ordinaryDir, basename(env.path)); await writeFile(ordinaryPath, '# Ordinary plan\n\nOrdinary work.');
  assert.equal((await readNativePlan(env.input)).title, 'Factory plan');
  await assert.rejects(readNativePlan({ ...env.input, factoryProjectId: undefined }), code('BAD_REQUEST'));
  await assert.rejects(readNativePlan({ ...env.input, submittedPath: ordinaryPath }), code('BAD_REQUEST'));
  assert.equal((await readNativePlan({ ...env.input, factoryProjectId: undefined, submittedPath: ordinaryPath })).title, 'Ordinary plan');
});

test('invalid native plan paths fail visibly, including nested paths and a different project', async t => {
  const env = await setup(t);
  const peer = join(env.root, 'peer'); await mkdir(getLocalPlansDir(peer), { recursive: true });
  const foreignPath = join(getLocalPlansDir(peer), 'implementation.md'); await writeFile(foreignPath, 'Foreign plan.');
  for (const submittedPath of ['', ' ', 'implementation.md', foreignPath, join(env.plansDir, 'nested', 'implementation.md'),
    join(env.plansDir, 'implementation.txt'), join(env.plansDir, 'bad\0.md')]) {
    await assert.rejects(readNativePlan({ ...env.input, submittedPath }), code('BAD_REQUEST'));
  }
});

test('missing, nonregular and unreadable plan files remain errors instead of approval previews', async t => {
  const env = await setup(t);
  await assert.rejects(readNativePlan(env.input), code('NOT_FOUND'));
  await mkdir(env.path); await assert.rejects(readNativePlan(env.input), code('BAD_REQUEST'));
  await rm(env.path, { recursive: true }); await writeFile(env.path, '# Readable\n\nRead this.');
  const preview = await readNativePlan(env.input);
  await chmod(env.path, 0);
  try { await assert.rejects(readNativePlan(env.input), code('BAD_REQUEST')); }
  finally { await chmod(env.path, 0o600); }
  await rm(env.path);
  await assert.rejects(rereadNativePlan(env.input, preview.version), code('NOT_FOUND'));
});

test('oversize plans fail visibly both at initial read and at response reread', async t => {
  const env = await setup(t);
  await writeFile(env.path, '# Small\n\nReviewable.');
  const preview = await readNativePlan(env.input);
  await writeFile(env.path, '# Large\n\n' + 'x'.repeat(1024 * 1024));
  await assert.rejects(readNativePlan(env.input), code('BAD_REQUEST'));
  await assert.rejects(rereadNativePlan(env.input, preview.version), code('BAD_REQUEST'));
});

test('native valid markdown without a heading and empty body remain exact SDK reads', async t => {
  const env = await setup(t);
  const path = join(env.plansDir, 'plain.MD');
  await writeFile(path, 'Direct native body.\r\n\r\n');
  const preview = await readNativePlan({ ...env.input, submittedPath: path });
  assert.equal(preview.title, ''); assert.equal(preview.plan, 'Direct native body.');
  await writeFile(env.path, '# Only heading\n\n');
  const headingOnly = await readNativePlan(env.input);
  assert.equal(headingOnly.title, 'Only heading'); assert.equal(headingOnly.plan, '');
});

test('lexically valid symlink reads preserve native semantics without adding a sandbox', async t => {
  const env = await setup(t);
  const actual = join(env.root, 'user-plan.md'); await writeFile(actual, '# User plan\n\nLocal trusted file.');
  await symlink(actual, env.path);
  assert.equal(isPlanFilePath(env.projectPath, env.input.submittedPath), true);
  const preview = await readNativePlan(env.input);
  assert.equal(preview.path, env.path); assert.equal(preview.title, 'User plan');
  await writeFile(actual, '# User plan\n\nUpdated local file.');
  await assert.rejects(rereadNativePlan(env.input, preview.version), code('CONFLICT'));
});
