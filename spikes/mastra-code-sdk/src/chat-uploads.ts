import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { ORPCError } from '@orpc/server';

export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export interface ChatFileAttachment {
  id: string;
  fileName: string;
  extension: string;
  relativePath: string;
  absolutePath: string;
  mimeType: string | null;
  sizeBytes: number;
}
export interface ChatFileUploadInput { cwd: string; chatId: string; file: File }
const invalid = (message: string) => new ORPCError('BAD_REQUEST', { message });
function safeComponent(value: string) {
  return Array.from(value, character => /^[A-Za-z0-9._-]$/.test(character) ? character : '_').join('').replace(/^\.+|\.+$/g, '') || 'file';
}
function displayName(value: string) {
  const name = basename(value.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_');
  return !name.trim() || name === '.' || name === '..' ? 'file' : name;
}
async function ensureDirectory(path: string) {
  let info;
  try { info = await fs.lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await fs.mkdir(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    info = await fs.lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalid('The upload directory contains an unsafe path component.');
}

/** The caller supplies the authoritative chat working directory. Match main's
 * local upload scope; component checks are not a filesystem sandbox or lock. */
export async function uploadChatFile(input: ChatFileUploadInput): Promise<ChatFileAttachment> {
  if (!input || typeof input.cwd !== 'string' || !input.cwd.trim() || !isAbsolute(input.cwd) || input.cwd.includes('\0')
    || typeof input.chatId !== 'string' || !input.chatId.trim() || !(input.file instanceof File)) {
    throw invalid('Provide a bound chat working directory and an uploaded file.');
  }
  const { file } = input;
  if (!file.size) throw invalid('The uploaded file is empty.');
  if (file.size > MAX_UPLOAD_FILE_BYTES) throw invalid('The uploaded file exceeds the 25 MiB limit.');
  if (file.type.toLowerCase().startsWith('image/')) throw invalid('Use the image upload operation for images.');
  const cwd = await fs.realpath(input.cwd);
  if (!(await fs.stat(cwd)).isDirectory()) throw invalid('The chat working directory must be a directory.');
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UPLOAD_FILE_BYTES) throw invalid('The uploaded file must contain between 1 byte and 25 MiB.');
  const id = randomUUID(), fileName = displayName(file.name);
  const components = ['.kodex', 'uploads', safeComponent(input.chatId), id];
  let directory = cwd;
  for (const component of components) { directory = join(directory, component); await ensureDirectory(directory); }
  const storedName = safeComponent(fileName), absolutePath = join(directory, storedName);
  const handle = await fs.open(absolutePath, 'wx');
  try { await handle.writeFile(bytes); }
  finally { await handle.close(); }
  return { id, fileName, extension: extname(fileName).slice(1).toLowerCase(),
    relativePath: [...components, storedName].join('/'), absolutePath, mimeType: file.type || null, sizeBytes: bytes.length };
}
