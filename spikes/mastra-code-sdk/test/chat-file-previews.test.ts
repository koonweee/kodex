import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ChatFilePreviewError, readChatFilePreview } from '../src/chat-file-previews.js';

async function setup(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'kodex-file-preview-')));
  const cwd = join(root, 'project'); await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, cwd };
}
const denied = (status: 404 | 415) => (error: unknown) => {
  assert.ok(error instanceof ChatFilePreviewError);
  assert.equal(error.status, status);
  assert.equal(error.message, status === 404 ? 'File preview not found.' : 'Unsupported file preview.');
  return true;
};

test('preview images use native-main signatures before extensions and return the original bytes', async t => {
  const { cwd } = await setup(t);
  for (const [name, bytes, contentType] of [
    ['png.md', Buffer.from('\x89PNG\r\n\x1a\nbody', 'latin1'), 'image/png'],
    ['jpeg.txt', Buffer.from([255, 216, 255, 0]), 'image/jpeg'],
    ['gif.bin', Buffer.from('GIF89a image'), 'image/gif'],
    ['webp.md', Buffer.from('RIFF0000WEBPbytes'), 'image/webp'],
    ['svg.local', Buffer.from(' <svg xmlns="urn:test"/>'), 'image/svg+xml'],
    ['xml.local', Buffer.from('<?xml version="1"?><svg/>'), 'image/svg+xml'],
  ] as const) {
    await fs.writeFile(join(cwd, name), bytes);
    assert.deepEqual(await readChatFilePreview({ cwd, path: name }), { bytes, contentType, contentDisposition: null });
  }
});

test('Markdown, PDF and arbitrary downloads preserve type and browser disposition contracts', async t => {
  const { cwd } = await setup(t);
  for (const [name, bytes, contentType, disposition] of [
    ['notes.MARKDOWN', Buffer.from('# Hello 🌏\n'), 'text/markdown; charset=utf-8', 'attachment'],
    ['document.PDF', Buffer.from('%PDF-1.7\npreview'), 'application/pdf', 'inline'],
    ['archive.bin', Buffer.from([0, 255, 1]), 'application/octet-stream', 'attachment'],
    ['empty.md', Buffer.alloc(0), 'text/markdown; charset=utf-8', 'attachment'],
    ['quote"\\.txt', Buffer.from('download'), 'application/octet-stream', 'attachment'],
  ] as const) {
    await fs.writeFile(join(cwd, name), bytes);
    assert.deepEqual(await readChatFilePreview({ cwd, path: name }), { bytes, contentType,
      contentDisposition: `${disposition}; filename="${name.replace(/[\\"]/g, '_')}"` });
  }
});

test('relative reads remain in canonical cwd while absolute host paths and contained symlinks retain main semantics', async t => {
  const { root, cwd } = await setup(t);
  await fs.mkdir(join(cwd, 'sub')); await fs.writeFile(join(cwd, 'sub', 'notes.md'), '# Inside');
  const outside = join(root, 'outside.md'); await fs.writeFile(outside, '# Outside');
  await fs.symlink(join(cwd, 'sub', 'notes.md'), join(cwd, 'inside-link'));
  await fs.symlink(outside, join(cwd, 'outside-link'));
  for (const path of ['sub/notes.md', 'sub//./notes.md', 'inside-link']) {
    const preview = await readChatFilePreview({ cwd, path });
    assert.equal(preview.bytes.toString(), '# Inside');
    assert.equal(preview.contentType, 'text/markdown; charset=utf-8');
  }
  for (const path of [outside, join(cwd, 'outside-link')]) assert.equal((await readChatFilePreview({ cwd, path })).bytes.toString(), '# Outside');
  for (const path of ['../outside.md', './sub/notes.md', 'sub/../sub/notes.md', 'outside-link']) await assert.rejects(readChatFilePreview({ cwd, path }), denied(404));
});

test('unavailable and malformed paths and unsupported contents have sanitized typed errors', async t => {
  const { cwd } = await setup(t);
  await fs.writeFile(join(cwd, 'bad.md'), Buffer.from([255, 254]));
  await fs.writeFile(join(cwd, 'bad.pdf'), 'not PDF');
  for (const path of ['', ' ', 'missing', 'bad\0path', cwd]) await assert.rejects(readChatFilePreview({ cwd, path }), denied(404));
  for (const path of ['bad.md', 'bad.pdf']) await assert.rejects(readChatFilePreview({ cwd, path }), denied(415));
});

test('type-specific main limits reject sparse oversized files and accept exact Markdown boundary', async t => {
  const { cwd } = await setup(t);
  for (const [name, prefix, maximum] of [
    ['large.image', Buffer.from('GIF87a'), 25 * 1024 * 1024],
    ['large.md', Buffer.from('text'), 2 * 1024 * 1024],
    ['large.pdf', Buffer.from('%PDF-'), 50 * 1024 * 1024],
    ['large.bin', Buffer.from('binary'), 100 * 1024 * 1024],
  ] as const) {
    const handle = await fs.open(join(cwd, name), 'w');
    try { await handle.write(prefix); await handle.truncate(maximum + 1); } finally { await handle.close(); }
    await assert.rejects(readChatFilePreview({ cwd, path: name }), denied(415));
  }
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65); await fs.writeFile(join(cwd, 'boundary.md'), bytes);
  assert.deepEqual((await readChatFilePreview({ cwd, path: 'boundary.md' })).bytes, bytes);
});

test('a file growing after classification is read only through its limit plus one before rejection', async t => {
  const { cwd } = await setup(t); const path = join(cwd, 'growing.md'); await fs.writeFile(path, 'small markdown');
  const originalOpen = fs.open.bind(fs); let readBytes = 0, observed = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await originalRead(buffer, offset, length, position); readBytes += result.bytesRead;
      if (!observed) { observed = true; await fs.truncate(path, 100 * 1024 * 1024); }
      return result;
    });
    return handle;
  });
  await assert.rejects(readChatFilePreview({ cwd, path }), denied(415));
  assert.equal(observed, true);
  assert.equal(readBytes, Buffer.byteLength('small markdown') + 2 * 1024 * 1024 + 1);
});

test('Unicode filenames remain downloadable through ASCII-safe Node headers with UTF-8 filename metadata', async t => {
  const { cwd } = await setup(t);
  const name = "报告's 🌏.md"; await fs.writeFile(join(cwd, name), '# Report');
  const preview = await readChatFilePreview({ cwd, path: name });
  assert.equal(preview.contentDisposition, "attachment; filename=\"__'s _.md\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%27s%20%F0%9F%8C%8F.md");
  assert.ok(/^[\x20-\x7e]+$/.test(preview.contentDisposition!));
});

test('SVG prefix whitespace matches native-main Unicode whitespace without stripping a BOM', async t => {
  const { cwd } = await setup(t);
  for (const [name, content, contentType] of [
    ['whitespace.local', '\u0085<svg/>', 'image/svg+xml'],
    ['bom.local', '\ufeff<svg/>', 'application/octet-stream'],
  ]) {
    await fs.writeFile(join(cwd, name), content);
    assert.equal((await readChatFilePreview({ cwd, path: name })).contentType, contentType);
  }
});
