import type { IncomingMessage, ServerResponse } from 'node:http';
import { ORPCError } from '@orpc/server';
import { ChatFilePreviewError } from './chat-file-previews.js';
import type { ChatService } from './chat-service.js';

/** Retained browser binary URL, backed solely by the native chat binding.
 * Like main, this exposes readable local files on a trusted localhost/VPN host.
 */
export async function handleFilePreview(request: IncomingMessage, response: ServerResponse, files: Pick<ChatService, 'previewFile'>): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = /^\/v1\/threads\/([^/]+)\/files\/preview$/.exec(url.pathname);
  if (!match) return false;
  const fail = (status: number, message: string) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message } }));
  };
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    fail(405, 'File previews require GET.');
    return true;
  }
  let chatId: string;
  try { chatId = decodeURIComponent(match[1]!); }
  catch { fail(400, 'Invalid chat identifier.'); return true; }
  const path = url.searchParams.get('path');
  if (!chatId || !path) { fail(400, 'A chat and file path are required.'); return true; }
  try {
    const preview = await files.previewFile({ chatId, path });
    response.writeHead(200, {
      'content-type': preview.contentType,
      'content-length': preview.bytes.length,
      'cache-control': 'private',
      ...(preview.contentDisposition && { 'content-disposition': preview.contentDisposition }),
    });
    response.end(preview.bytes);
  } catch (error) {
    const status = error instanceof ChatFilePreviewError ? error.status
      : error instanceof ORPCError && error.code === 'NOT_FOUND' ? 404 : 500;
    fail(status, status === 404 ? 'File preview not found.' : status === 415 ? 'Unsupported file preview.' : 'File preview could not be read.');
  }
  return true;
}
