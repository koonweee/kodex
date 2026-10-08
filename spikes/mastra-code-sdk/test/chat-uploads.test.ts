import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ORPCError } from '@orpc/server';
import { MAX_UPLOAD_FILE_BYTES, uploadChatFile } from '../src/chat-uploads.js';

async function setup(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'kodex-chat-upload-')));
  const cwd = join(root, 'project'); await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cwd, chatId: 'chat-id' };
}
const badRequest = (error: unknown) => error instanceof ORPCError && error.code === 'BAD_REQUEST';

test('generic upload preserves bytes and main descriptor fields in its bound project', async t => {
  const env = await setup(t);
  const file = new File(['# Notes\n\nNative attachment.'], 'Design notes.MD', { type: 'text/markdown' });
  const result = await uploadChatFile({ ...env, file });
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(result, { id: result.id, fileName: 'Design notes.MD', extension: 'md',
    relativePath: `.kodex/uploads/chat-id/${result.id}/Design_notes.MD`,
    absolutePath: join(env.cwd, '.kodex', 'uploads', 'chat-id', result.id, 'Design_notes.MD'),
    mimeType: 'text/markdown', sizeBytes: file.size });
  assert.equal(await fs.readFile(result.absolutePath, 'utf8'), await file.text());
  assert.equal(relative(env.cwd, result.absolutePath).replaceAll('\\', '/'), result.relativePath);
});

test('traversal and unusual filenames become safe components without losing friendly names', async t => {
  const env = await setup(t);
  const cases = [
    { name: '../../outside/notes.txt', display: 'notes.txt', stored: 'notes.txt', extension: 'txt' },
    { name: '..\\outside\\报告?.TXT', display: '报告?.TXT', stored: '___.TXT', extension: 'txt' },
    { name: 'bad\0\nname.txt', display: 'bad__name.txt', stored: 'bad__name.txt', extension: 'txt' },
    { name: '', display: 'file', stored: 'file', extension: '' },
    { name: '..', display: 'file', stored: 'file', extension: '' },
  ];
  for (const value of cases) {
    const result = await uploadChatFile({ ...env, chatId: '../../chat/../scope', file: new File(['contents'], value.name) });
    assert.equal(result.fileName, value.display); assert.equal(result.extension, value.extension);
    assert.equal(basename(result.absolutePath), value.stored); assert.equal(result.mimeType, null);
    assert.equal(result.relativePath, `.kodex/uploads/_.._chat_.._scope/${result.id}/${value.stored}`);
    assert.equal(await fs.readFile(result.absolutePath, 'utf8'), 'contents');
    assert.equal(result.relativePath.split('/').some(part => part === '..' || part === '.' || !part), false);
  }
  await assert.rejects(fs.stat(join(env.root, 'outside')), { code: 'ENOENT' });
});

test('empty, over-limit, image and invalid bound inputs create no upload directories', async t => {
  const env = await setup(t);
  for (const file of [new File([], 'empty.txt'), new File([new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1)], 'large.bin'),
    new File(['image'], 'pixel.png', { type: 'image/png' })]) {
    await assert.rejects(uploadChatFile({ ...env, file }), badRequest);
  }
  const file = new File(['valid'], 'notes.txt');
  for (const input of [{ ...env, cwd: '' }, { ...env, cwd: 'relative/path' }, { ...env, cwd: 'bad\0path' },
    { ...env, chatId: '' }, { ...env, chatId: '  ' }]) await assert.rejects(uploadChatFile({ ...input, file }), badRequest);
  await assert.rejects(uploadChatFile({ ...env, file: {} as File }), badRequest);
  assert.deepEqual(await fs.readdir(env.cwd), []);
});

test('the full 25 MiB main limit is accepted without truncating binary bytes', async t => {
  const env = await setup(t);
  const bytes = new Uint8Array(MAX_UPLOAD_FILE_BYTES); bytes[0] = 1; bytes[bytes.length - 1] = 255;
  const result = await uploadChatFile({ ...env, file: new File([bytes], 'limit.bin', { type: 'application/octet-stream' }) });
  assert.equal(result.sizeBytes, MAX_UPLOAD_FILE_BYTES);
  assert.deepEqual(await fs.readFile(result.absolutePath), Buffer.from(bytes));
});

test('every existing upload directory component rejects symlinks and non-directories', async t => {
  const env = await setup(t);
  const outside = join(env.root, 'outside'); await fs.mkdir(outside);
  for (const kind of ['symlink', 'file']) for (const parts of [['.kodex'], ['.kodex', 'uploads'], ['.kodex', 'uploads', env.chatId]]) {
    await fs.rm(join(env.cwd, '.kodex'), { recursive: true, force: true });
    const parent = join(env.cwd, ...parts.slice(0, -1)); await fs.mkdir(parent, { recursive: true });
    const path = join(env.cwd, ...parts);
    if (kind === 'symlink') await fs.symlink(outside, path); else await fs.writeFile(path, 'untouched');
    await assert.rejects(uploadChatFile({ ...env, file: new File(['payload'], 'notes.txt') }), badRequest);
    assert.deepEqual(await fs.readdir(outside), []);
    if (kind === 'file') assert.equal(await fs.readFile(path, 'utf8'), 'untouched');
  }
});

test('simultaneous same-chat uploads stay distinct and exclusive creation never overwrites', async t => {
  const env = await setup(t);
  const results = await Promise.all(['first', 'second'].map(value => uploadChatFile({ ...env, file: new File([value], 'notes.txt') })));
  assert.notEqual(results[0]!.id, results[1]!.id);
  assert.deepEqual(await Promise.all(results.map(value => fs.readFile(value.absolutePath, 'utf8'))), ['first', 'second']);
  const open = fs.open.bind(fs);
  let collisionPath: string | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    collisionPath = String(args[0]); await fs.writeFile(collisionPath, 'existing file');
    return open(...args);
  });
  await assert.rejects(uploadChatFile({ ...env, file: new File(['replacement'], 'collision.txt') }));
  assert.ok(collisionPath); assert.equal(await fs.readFile(collisionPath, 'utf8'), 'existing file');
});
