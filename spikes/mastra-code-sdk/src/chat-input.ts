import type { NativeSkillReference, NativeSkillMention, PreparedNativeSkills } from './chat-skills.js';
import type { AgentMessageInput } from '@mastra/core/agent';
import { ORPCError } from '@orpc/server';
import { extname } from 'node:path';
import { readChatImage, type ChatImageUpload } from './chat-image-uploads.js';
import { MAX_UPLOAD_FILE_BYTES, safeUploadComponent, type ChatFileAttachment } from './chat-uploads.js';

export interface ChatInput { text: string; images?: ChatImageUpload[]; files?: ChatFileAttachment[]; skills?: NativeSkillReference[]; skillMentions?: NativeSkillMention[] }
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
  if (value.skills !== undefined && (!Array.isArray(value.skills) || !value.skills.every(skill => object(skill) && string(skill.name, 256) && string(skill.path)))) return false;
  if (value.skillMentions !== undefined && (!Array.isArray(value.skillMentions) || !value.skillMentions.every(mention => object(mention) && string(mention.name, 256) && string(mention.path) && Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end)))) return false;
  return Boolean((value.skills as unknown[] | undefined)?.length || value.text.trim() || (value.images as unknown[] | undefined)?.length || (value.files as unknown[] | undefined)?.length);
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
export async function prepareChatInput({ chatId, imageRoot, input, prepareSkills }: { chatId: string; imageRoot: string; input: ChatInput; prepareSkills?: (references: NativeSkillReference[]) => Promise<PreparedNativeSkills> }): Promise<PreparedChatInput> {
  if (!validChatInput(input)) throw new ORPCError('BAD_REQUEST', { message: 'Input must contain text or attachments.' });
  if (input.skills?.length && !prepareSkills) throw new ORPCError('BAD_REQUEST', { message: 'Native skill preparation is required.' });
  const mentions = (input.skillMentions ?? []).map(({ name, path, start, end }) => ({ name, path, start, end }));
  if (mentions.some(mention => mention.start < 0 || mention.end <= mention.start || mention.end > input.text.length || input.text.slice(mention.start, mention.end) !== `$${mention.name}` || !input.skills?.some(skill => skill.name === mention.name && skill.path === mention.path))) throw new ORPCError('BAD_REQUEST', { message: 'Invalid skill mention.' });
  const ordered = [...mentions].sort((left, right) => left.start - right.start);
  if (ordered.some((mention, index) => index > 0 && ordered[index - 1]!.end > mention.start)) throw new ORPCError('BAD_REQUEST', { message: 'Overlapping skill mentions.' });
  const skills = input.skills?.length ? await prepareSkills!(input.skills.map(({ name, path }) => ({ name, path }))) : undefined;
  const files = input.files?.map(file => fileReference(chatId, file)) ?? [];
  const envelope = files.length ? `\`\`\`kodex-attachments\n${files.map(file => `- ${file.relativePath}`).join('\n')}\n\`\`\`` : '';
  const referencedText = envelope ? [input.text, envelope].filter(Boolean).join('\n\n') : input.text;
  const text = [referencedText, skills?.activation].filter(Boolean).join('\n\n');
  const images = await Promise.all((input.images ?? []).map(image => readChatImage({ imageRoot, image })));
  return { contents: images.length ? [...(text ? [{ type: 'text' as const, text }] : []), ...images] : text,
    ...((files.length || skills) && { metadata: { ...(files.length && { kodexAttachments: files }), ...(skills && { kodexSkillInput: { text: input.text, skills: skills.references, mentions } }) } }) };
}
