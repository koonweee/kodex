import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';

export class ChatFilePreviewError extends Error {
  constructor(readonly status: 404 | 415) {
    super(status === 404 ? 'File preview not found.' : 'Unsupported file preview.');
    this.name = 'ChatFilePreviewError';
  }
}
export interface ChatFilePreview {
  bytes: Buffer;
  contentType: string;
  contentDisposition: string | null;
}
type PreviewKind = { contentType: string; maximum: number; disposition: 'inline' | 'attachment' | null };
const unavailable = () => new ChatFilePreviewError(404);
const unsupported = () => new ChatFilePreviewError(415);
const mib = 1024 * 1024;

async function canonicalPath(cwd: string, path: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw unavailable();
  if (isAbsolute(path)) return fs.realpath(path);
  // Rust Path::components preserves a leading CurDir but normalizes interior
  // dots, repeated separators and a trailing separator. ParentDir is rejected.
  const components = path.split(sep);
  if (components[0] === '.' || components.includes('..')) throw unavailable();
  const root = await fs.realpath(cwd);
  const canonical = await fs.realpath(join(root, path));
  const descendant = relative(root, canonical);
  if (descendant === '..' || descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) throw unavailable();
  return canonical;
}
function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) || bytes.subarray(0, 6).equals(Buffer.from('GIF89a'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\p{White_Space}+/u, '');
    if (text.startsWith('<svg') || text.startsWith('<?xml')) return 'image/svg+xml';
  } catch { /* A non-UTF8 prefix is not an SVG preview. */ }
  return null;
}
function classify(path: string, header: Buffer): PreviewKind {
  const image = imageType(header);
  if (image) return { contentType: image, maximum: 25 * mib, disposition: null };
  const extension = extname(path).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return { contentType: 'text/markdown; charset=utf-8', maximum: 2 * mib, disposition: 'attachment' };
  if (extension === '.pdf') return { contentType: 'application/pdf', maximum: 50 * mib, disposition: 'inline' };
  return { contentType: 'application/octet-stream', maximum: 100 * mib, disposition: 'attachment' };
}
async function readBounded(file: FileHandle, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - size));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
    if (!bytesRead) return Buffer.concat(chunks, size);
    size += bytesRead;
    if (size > maximum) throw unsupported();
    chunks.push(chunk.subarray(0, bytesRead));
  }
}
function validateBytes(kind: PreviewKind, bytes: Buffer) {
  if (kind.contentType.startsWith('image/')) {
    if (imageType(bytes) !== kind.contentType) throw unsupported();
  } else if (kind.contentType === 'text/markdown; charset=utf-8') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw unsupported(); }
  } else if (kind.contentType === 'application/pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw unsupported();
}

/** Local/trusted-VPN preview semantics match the existing product route. The
 * caller resolves the authoritative chat cwd; absolute readable host paths are
 * intentionally supported. Canonicalization is not a filesystem transaction.
 */
export async function readChatFilePreview({ cwd, path }: { cwd: string; path: string }): Promise<ChatFilePreview> {
  let file: FileHandle | undefined;
  try {
    const canonical = await canonicalPath(cwd, path);
    // Avoid blocking on a nonregular target before the opened-file stat check.
    file = await fs.open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile()) throw unavailable();
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const kind = classify(canonical, header.subarray(0, bytesRead));
    if (metadata.size > kind.maximum) throw unsupported();
    const bytes = await readBounded(file, kind.maximum);
    validateBytes(kind, bytes);
    const filename = basename(canonical).replace(/[\\"\u0000-\u001f\u007f]/g, '_');
    const asciiFilename = filename.replace(/[^\x20-\x7e]/gu, '_');
    const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const utf8Filename = asciiFilename === filename ? '' : `; filename*=UTF-8''${encodedFilename}`;
    return { bytes, contentType: kind.contentType,
      contentDisposition: kind.disposition ? `${kind.disposition}; filename="${asciiFilename}"${utf8Filename}` : null };
  } catch (error) {
    if (error instanceof ChatFilePreviewError) throw error;
    throw unavailable();
  } finally { await file?.close().catch(() => {}); }
}
