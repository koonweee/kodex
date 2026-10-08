/** Native thread tags for a fresh delegated child; no separate relation store. */
export const KODEX_CHILD_TAG = 'kodexChild';
export const KODEX_CHILD_VERSION = '1';
export interface ChildRelation {
  parentThreadId: string;
  parentResourceId: string;
  /** Empty string means the native parent session is unscoped. */
  parentSessionScope: string;
  parentTaskId: string;
}
/** Recognize the marker independently so malformed children stay out of chat creation/edit routes. */
export function isChildThread(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[KODEX_CHILD_TAG] !== undefined;
}
export function readChildRelation(metadata: Record<string, unknown> | undefined): ChildRelation | null {
  if (metadata?.[KODEX_CHILD_TAG] !== KODEX_CHILD_VERSION
    || typeof metadata.parentThreadId !== 'string' || !metadata.parentThreadId
    || typeof metadata.parentResourceId !== 'string' || !metadata.parentResourceId
    || typeof metadata.parentSessionScope !== 'string'
    || typeof metadata.parentTaskId !== 'string' || !metadata.parentTaskId) return null;
  return { parentThreadId: metadata.parentThreadId, parentResourceId: metadata.parentResourceId,
    parentSessionScope: metadata.parentSessionScope, parentTaskId: metadata.parentTaskId };
}
