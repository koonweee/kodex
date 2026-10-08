import type { TimelineImage, TimelineItem } from '../timeline/state';

type ImageFields = Pick<TimelineItem, 'kind' | 'path' | 'imageSrc' | 'resultSummary'>;

/** Only actual image bytes returned by the native view tool authorize a preview.
 * Filenames and textual results never route to the old gateway's preview API.
 */
export function nativeImageFields(toolName: string, args: unknown, result: unknown, failed: boolean): ImageFields | null {
  if (failed || toolName !== 'view' || typeof result !== 'object' || result === null) return null;
  const media = result as Record<string, unknown>;
  if (media.__workspaceMedia !== true || typeof media.mediaType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(media.mediaType)
    || typeof media.data !== 'string' || !media.data || typeof media.text !== 'string') return null;
  const path = typeof args === 'object' && args !== null && 'path' in args && typeof args.path === 'string' ? args.path : undefined;
  return { kind: 'image_view', path, imageSrc: `data:${media.mediaType.toLowerCase()};base64,${media.data}`, resultSummary: undefined };
}

/** Native saved input files carry bytes, MIME type and an optional filename.
 * The filename is a thumbnail label; the data URL supplies the image itself.
 */
export function nativeInputImages(parts: readonly unknown[]): TimelineImage[] {
  return parts.flatMap(part => {
    if (typeof part !== 'object' || part === null) return [];
    const file = part as Record<string, unknown>;
    if (file.type !== 'file' || typeof file.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(file.mimeType)
      || typeof file.data !== 'string') return [];
    const data = file.data.replace(/\s/g, '');
    // Accept padded or unpadded native base64 without MIME/format allowlists.
    // A path or remote URL must never fall through to legacy file previews.
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1 || data.includes('=') && data.length % 4 !== 0) return [];
    return [{ url: `data:${file.mimeType.toLowerCase()};base64,${data}`, ...(typeof file.filename === 'string' && file.filename && { path: file.filename }) }];
  });
}
