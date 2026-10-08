import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { ORPCError } from '@orpc/server';
import { MAX_UPLOAD_FILE_BYTES } from './chat-uploads.js';

export interface ChatImageUpload { id: string; fileName: string; mimeType: string; sizeBytes: number; path: string }
export interface ChatImageReadInput { imageRoot: string; image: Pick<ChatImageUpload, 'path' | 'mimeType' | 'fileName'> }
export interface ChatImagePart { type: 'file'; data: string; mediaType: string; filename: string }
const invalid = (message: string) => new ORPCError('BAD_REQUEST', { message });
const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function imageType(value: string) {
  if (typeof value !== 'string' || !/^image\/[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(value)) throw invalid('Provide a valid image MIME type.');
  return value.toLowerCase();
}
function checkName(value: string) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid('Provide an image filename without control characters, at most 1024 bytes.');
  }
}
function checkSize(size: number) {
  if (!size || size > MAX_UPLOAD_FILE_BYTES) throw invalid('The image must contain between 1 byte and 25 MiB.');
}
function checkRoot(value: string) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || value.includes('\0')) throw invalid('Provide an image upload directory.');
}
async function canonicalRoot(value: string, create: boolean) {
  checkRoot(value);
  if (create) await fs.mkdir(value, { recursive: true });
  const info = await fs.lstat(value);
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalid('The image upload directory must be a regular directory.');
  return fs.realpath(value);
}
/** Match main's structural PNG validation; other image formats retain MIME-only validation. */
function validateBytes(mimeType: string, bytes: Buffer) {
  checkSize(bytes.length);
  if (mimeType !== 'image/png') return;
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw invalid('Invalid PNG image: missing PNG signature.');
  let offset = 8, sawHeader = false, sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), dataEnd = offset + 8 + length, crcEnd = dataEnd + 4;
    if (crcEnd > bytes.length) throw invalid('Invalid PNG image: truncated chunk.');
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))) throw invalid('Invalid PNG image: chunk CRC mismatch.');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') {
      if (offset !== 8) throw invalid('Invalid PNG image: IHDR must be the first chunk.');
      sawHeader = true;
    } else if (type === 'IEND') {
      if (crcEnd !== bytes.length) throw invalid('Invalid PNG image: trailing bytes after IEND.');
      sawEnd = true; break;
    }
    offset = crcEnd;
  }
  if (!sawHeader) throw invalid('Invalid PNG image: missing IHDR chunk.');
  if (!sawEnd) throw invalid('Invalid PNG image: missing IEND chunk.');
}

export async function uploadChatImage({ imageRoot, file }: { imageRoot: string; file: File }): Promise<ChatImageUpload> {
  checkRoot(imageRoot);
  if (!(file instanceof File)) throw invalid('Provide an uploaded image file.');
  const mimeType = imageType(file.type), fileName = file.name || 'image';
  checkName(fileName); checkSize(file.size);
  const bytes = Buffer.from(await file.arrayBuffer()); validateBytes(mimeType, bytes);
  const root = await canonicalRoot(imageRoot, true), id = randomUUID();
  const path = join(root, `${id}.${extensions[mimeType] ?? 'img'}`);
  const handle = await fs.open(path, 'wx');
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  return { id, fileName, mimeType, sizeBytes: bytes.length, path };
}

/** Resolve only generated staging files. MIME and display name are carried in
 * the upload descriptor; unknown image subtypes cannot be recovered from .img. */
export async function readChatImage({ imageRoot, image }: ChatImageReadInput): Promise<ChatImagePart> {
  checkRoot(imageRoot);
  if (!image || typeof image.path !== 'string' || !isAbsolute(image.path) || image.path.includes('\0')) throw invalid('Provide a generated image upload path.');
  const mimeType = imageType(image.mimeType); checkName(image.fileName);
  const root = await canonicalRoot(imageRoot, false), filename = basename(image.path);
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|gif|webp|heic|heif|img)$/.exec(filename);
  if (dirname(image.path) !== root || !match || match[2] !== (extensions[mimeType] ?? 'img')) throw invalid('The image must name a generated upload inside the image directory with its matching MIME type.');
  const info = await fs.lstat(image.path);
  if (info.isSymbolicLink() || !info.isFile()) throw invalid('The image upload must be a regular file.');
  checkSize(info.size);
  // Native no-follow prevents a final-component symlink replacement during open.
  const handle = await fs.open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw invalid('The image upload must be a regular file.');
    checkSize(opened.size); bytes = await handle.readFile();
  } finally { await handle.close(); }
  validateBytes(mimeType, bytes);
  return { type: 'file', data: bytes.toString('base64'), mediaType: mimeType, filename: image.fileName };
}
