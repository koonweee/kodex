import type { TimelineItem } from '../timeline/state';

const operations: Record<string, string> = {
  view: 'Read', write_file: 'Write', string_replace_lsp: 'Replace', ast_smart_edit: 'Edit', delete_file: 'Delete',
};

/** Native file tools describe requested operations. Their normal string results
 * can include refusals, failures and no-ops, so completion never proves a change.
 */
export function nativeFileFields(name: string, args: unknown): Pick<TimelineItem, 'kind' | 'path' | 'action' | 'fileChangeOutcomeKnown'> | null {
  if (!Object.hasOwn(operations, name) || typeof args !== 'object' || args === null || !('path' in args) || typeof args.path !== 'string' || !args.path) return null;
  return { kind: 'file_change', path: args.path, action: operations[name], fileChangeOutcomeKnown: false };
}
