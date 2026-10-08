import type { TimelineItem } from '../timeline/state';

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
