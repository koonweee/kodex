import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { ORPCError } from '@orpc/server';
import { MAX_UPLOAD_FILE_BYTES } from '../src/chat-uploads.js';
import { readChatImage, uploadChatImage } from '../src/chat-image-uploads.js';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const png = Buffer.from(pngBase64, 'base64');
const signature = png.subarray(0, 8);
function chunk(type: string, data = Buffer.alloc(0)) {
  const value = Buffer.alloc(data.length + 12);
  value.writeUInt32BE(data.length, 0); value.write(type, 4, 'ascii'); data.copy(value, 8);
  value.writeUInt32BE(crc32(value.subarray(4, 8 + data.length)), 8 + data.length);
  return value;
}
async function setup(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'kodex-chat-image-upload-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, imageRoot: join(root, 'profile', 'uploads', 'images') };
}
const badRequest = (error: unknown) => error instanceof ORPCError && error.code === 'BAD_REQUEST';

test('PNG staging preserves the main descriptor and reads native bytes with the original filename', async t => {
  const env = await setup(t);
  const image = await uploadChatImage({ imageRoot: env.imageRoot, file: new File([png], 'My pixel.png', { type: 'image/png' }) });
  assert.match(image.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(image, { id: image.id, fileName: 'My pixel.png', mimeType: 'image/png', sizeBytes: png.length,
    path: join(env.imageRoot, `${image.id}.png`) });
  assert.deepEqual(await fs.readFile(image.path), png);
  assert.deepEqual(await readChatImage({ imageRoot: env.imageRoot, image }),
    { type: 'file', data: pngBase64, mediaType: 'image/png', filename: 'My pixel.png' });
});

test('known image extensions and arbitrary valid subtypes preserve MIME without a metadata store', async t => {
  const env = await setup(t);
  for (const [mimeType, extension] of [['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
    ['image/heic', 'heic'], ['image/heif', 'heif'], ['image/svg+xml', 'img'], ['image/x-test-format', 'img']]) {
    const image = await uploadChatImage({ imageRoot: env.imageRoot, file: new File(['image bytes'], 'original.image', { type: mimeType }) });
    assert.equal(basename(image.path), `${image.id}.${extension}`);
    assert.deepEqual(await readChatImage({ imageRoot: env.imageRoot, image }),
      { type: 'file', data: Buffer.from('image bytes').toString('base64'), mediaType: mimeType, filename: 'original.image' });
  }
});

test('invalid image inputs are rejected before any staged file is created', async t => {
  const env = await setup(t);
  for (const file of [new File([], 'empty.png', { type: 'image/png' }),
    new File([new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1)], 'huge.gif', { type: 'image/gif' }),
    new File(['data'], 'file.txt', { type: 'text/plain' }), new File(['data'], 'file.img', { type: 'image/' }),
    new File(['data'], 'file.img', { type: 'image/bad type' }), new File(['data'], 'bad\0name.gif', { type: 'image/gif' }),
    new File(['data'], 'x'.repeat(1025), { type: 'image/gif' })]) {
    await assert.rejects(uploadChatImage({ imageRoot: env.imageRoot, file }), badRequest);
  }
  for (const imageRoot of ['', 'relative/path', '/bad\0path']) await assert.rejects(uploadChatImage({ imageRoot, file: new File([png], 'pixel.png', { type: 'image/png' }) }), badRequest);
  await assert.rejects(uploadChatImage({ imageRoot: env.imageRoot, file: {} as File }), badRequest);
  await assert.rejects(fs.stat(env.imageRoot), { code: 'ENOENT' });
});

test('PNG signature, bounds, CRC, first IHDR and final IEND match main validation', async t => {
  const env = await setup(t);
  const badCrc = Buffer.from(png); badCrc[29] = badCrc[29]! ^ 1;
  const disguisedHeader = Buffer.from(png); disguisedHeader[12] = disguisedHeader[12]! | 128;
  disguisedHeader.writeUInt32BE(crc32(disguisedHeader.subarray(12, 29)), 29);
  const hugeChunk = Buffer.alloc(12); hugeChunk.writeUInt32BE(0xffff_ffff, 0); hugeChunk.write('IDAT', 4);
  const invalid = [Buffer.from('not PNG'), signature, badCrc, disguisedHeader, png.subarray(0, png.length - 1),
    Buffer.concat([signature, hugeChunk]), Buffer.concat([signature, chunk('IEND')]),
    Buffer.concat([signature, chunk('IHDR', Buffer.alloc(13))]),
    Buffer.concat([signature, chunk('tEXt'), chunk('IHDR', Buffer.alloc(13)), chunk('IEND')]),
    Buffer.concat([png, Buffer.from('trailing')])];
  for (const bytes of invalid) await assert.rejects(uploadChatImage({ imageRoot: env.imageRoot, file: new File([bytes], 'bad.png', { type: 'image/png' }) }), badRequest);
  await assert.rejects(fs.stat(env.imageRoot), { code: 'ENOENT' });
});

test('image reads reject outside, non-generated, mismatched and symlink paths before exposing bytes', async t => {
  const env = await setup(t);
  const image = await uploadChatImage({ imageRoot: env.imageRoot, file: new File([png], 'pixel.png', { type: 'image/png' }) });
  const outside = join(env.root, `${image.id}.png`); await fs.writeFile(outside, png);
  for (const changed of [{ path: outside }, { path: join(env.imageRoot, 'pixel.png') },
    { path: `${env.imageRoot}/../images/${image.id}.png` }, { path: `${image.id}.png` }, { mimeType: 'image/jpeg' },
    { mimeType: 'text/plain' }, { mimeType: 'image/bad type' }, { fileName: 'bad\nname.png' }, { fileName: 'x'.repeat(1025) }]) {
    await assert.rejects(readChatImage({ imageRoot: env.imageRoot, image: { ...image, ...changed } }), badRequest);
  }
  await fs.rm(image.path); await fs.symlink(outside, image.path);
  await assert.rejects(readChatImage({ imageRoot: env.imageRoot, image }), badRequest);
  assert.deepEqual(await fs.readFile(outside), png);
});

test('reads bound actual file size and revalidate PNG bytes after staging changes', async t => {
  const env = await setup(t);
  const image = await uploadChatImage({ imageRoot: env.imageRoot, file: new File([png], 'pixel.png', { type: 'image/png' }) });
  await fs.writeFile(image.path, 'invalid PNG'); await assert.rejects(readChatImage({ imageRoot: env.imageRoot, image }), badRequest);
  await fs.writeFile(image.path, new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1)); await assert.rejects(readChatImage({ imageRoot: env.imageRoot, image }), badRequest);
  await fs.writeFile(image.path, ''); await assert.rejects(readChatImage({ imageRoot: env.imageRoot, image }), badRequest);
  await fs.rm(image.path); await fs.mkdir(image.path); await assert.rejects(readChatImage({ imageRoot: env.imageRoot, image }), badRequest);
});

test('full-limit non-PNG images remain MIME-only and simultaneous uploads stay distinct', async t => {
  const env = await setup(t);
  const bytes = new Uint8Array(MAX_UPLOAD_FILE_BYTES); bytes[0] = 1; bytes[bytes.length - 1] = 255;
  const image = await uploadChatImage({ imageRoot: env.imageRoot, file: new File([bytes], 'limit.gif', { type: 'image/gif' }) });
  assert.equal(image.sizeBytes, MAX_UPLOAD_FILE_BYTES);
  assert.deepEqual(await fs.readFile(image.path), Buffer.from(bytes));
  const values = await Promise.all(['one', 'two'].map(value => uploadChatImage({ imageRoot: env.imageRoot, file: new File([value], 'same.gif', { type: 'image/gif' }) })));
  assert.notEqual(values[0]!.path, values[1]!.path);
  assert.deepEqual(await Promise.all(values.map(value => fs.readFile(value.path, 'utf8'))), ['one', 'two']);
});


test('the caller-owned staging directory rejects a symlink or non-directory root', async t => {
  const env = await setup(t);
  const outside = join(env.root, 'outside'); await fs.mkdir(outside);
  await fs.mkdir(join(env.root, 'profile', 'uploads'), { recursive: true });
  const file = new File([png], 'pixel.png', { type: 'image/png' });
  await fs.symlink(outside, env.imageRoot);
  await assert.rejects(uploadChatImage({ imageRoot: env.imageRoot, file }), badRequest);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.rm(env.imageRoot); await fs.writeFile(env.imageRoot, 'existing file');
  await assert.rejects(uploadChatImage({ imageRoot: env.imageRoot, file }));
  assert.equal(await fs.readFile(env.imageRoot, 'utf8'), 'existing file');
});
