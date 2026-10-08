import type { TimelineFileAttachment } from '../api/client';
import { payloadRecord, stripAttachmentEnvelope } from '../timeline/presentationShared';

/** Native user signals persist the validated upload references in signal metadata.
 * Project only that owned shape, never supplied absolute paths or extra payload.
 */
export function nativeInputFiles(metadata: unknown): TimelineFileAttachment[] {
  const signal = payloadRecord(payloadRecord(metadata)?.signal);
  const attachments = payloadRecord(signal?.metadata)?.kodexAttachments;
  if (!Array.isArray(attachments)) return [];
  const result: TimelineFileAttachment[] = [];
  for (const value of attachments) {
    const file = payloadRecord(value);
    if (!file || typeof file.id !== 'string' || !file.id || typeof file.fileName !== 'string' || !file.fileName.trim()
      || /[\\/\x00-\x1f\x7f]/.test(file.fileName) || typeof file.extension !== 'string'
      || typeof file.relativePath !== 'string' || !file.relativePath.startsWith('.kodex/uploads/')
      || /[\\\r\n\0]/.test(file.relativePath) || file.relativePath.includes('```')
      || file.relativePath.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes as number) < 0
      || file.mimeType !== undefined && file.mimeType !== null && typeof file.mimeType !== 'string') return [];
    result.push({ id: file.id, fileName: file.fileName, extension: file.extension, relativePath: file.relativePath,
      sizeBytes: file.sizeBytes as number, ...(file.mimeType !== undefined && { mimeType: file.mimeType as string | null }) });
  }
  return result;
}

/** A matching ordered native attachment list authorizes removal of its generated
 * suffix. Preserve arbitrary examples and mismatched user-written envelopes.
 */
export function nativeInputFileText(text: string, files: TimelineFileAttachment[]): string {
  if (!files.length) return text;
  const suffix = `\`\`\`kodex-attachments\n${files.map(file => `- ${file.relativePath}`).join('\n')}\n\`\`\``;
  return text.trimEnd().endsWith(suffix) ? stripAttachmentEnvelope(text) : text;
}
