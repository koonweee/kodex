import type { AgentMessageInput } from '@mastra/core/agent';
import { ORPCError } from '@orpc/server';
import { extname } from 'node:path';
import { readChatImage, type ChatImageUpload } from './chat-image-uploads.js';
import { MAX_UPLOAD_FILE_BYTES, safeUploadComponent, type ChatFileAttachment } from './chat-uploads.js';

export interface ChatInput { text: string; images?: ChatImageUpload[]; files?: ChatFileAttachment[] }
export type PreparedChatInput = Extract<AgentMessageInput, { contents: unknown }>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const size = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_UPLOAD_FILE_BYTES;
/** Wire validation is separate from authoritative path checks during preparation. */
export function validChatInput(value: unknown): value is ChatInput {
  if (!object(value) || typeof value.text !== 'string' || value.text.length > 100_000) return false;
  if (value.images !== undefined && (!Array.isArray(value.images) || !value.images.every(image => object(image)
    && string(image.id, 256) && string(image.path) && string(image.fileName) && string(image.mimeType, 256) && size(image.sizeBytes)))) return false;
  if (value.files !== undefined && (!Array.isArray(value.files) || !value.files.every(file => object(file)
    && string(file.id, 256) && string(file.relativePath) && string(file.fileName) && typeof file.extension === 'string'
    && (file.mimeType === null || string(file.mimeType, 256)) && size(file.sizeBytes)))) return false;
  return Boolean(value.text.trim() || (value.images as unknown[] | undefined)?.length || (value.files as unknown[] | undefined)?.length);
}
function fileReference(chatId: string, file: ChatFileAttachment) {
  const path = file.relativePath;
  if (path.trim() !== path || !path.startsWith(`.kodex/uploads/${safeUploadComponent(chatId)}/`)
    || /[\\\r\n\0]/.test(path) || path.includes('```') || path.split('/').some(part => !part || part === '.' || part === '..')
    || !file.fileName.trim() || /[\\/\r\n\0]/.test(file.fileName)) {
    throw new ORPCError('BAD_REQUEST', { message: 'Invalid file attachment reference.' });
  }
  // As in main, the server validates relative scope and discards supplied absolute paths.
  return { id: file.id, fileName: file.fileName, extension: extname(file.fileName).slice(1).toLowerCase(),
    relativePath: file.relativePath, mimeType: file.mimeType, sizeBytes: file.sizeBytes, absolutePath: undefined };
}
export async function prepareChatInput({ chatId, imageRoot, input }: { chatId: string; imageRoot: string; input: ChatInput }): Promise<PreparedChatInput> {
  if (!validChatInput(input)) throw new ORPCError('BAD_REQUEST', { message: 'Input must contain text or attachments.' });
  const files = input.files?.map(file => fileReference(chatId, file)) ?? [];
  const envelope = files.length ? `\`\`\`kodex-attachments\n${files.map(file => `- ${file.relativePath}`).join('\n')}\n\`\`\`` : '';
  const text = envelope ? [input.text, envelope].filter(Boolean).join('\n\n') : input.text;
  const images = await Promise.all((input.images ?? []).map(image => readChatImage({ imageRoot, image })));
  return { contents: images.length ? [...(text ? [{ type: 'text' as const, text }] : []), ...images] : text,
    ...(files.length && { metadata: { kodexAttachments: files } }) };
}
