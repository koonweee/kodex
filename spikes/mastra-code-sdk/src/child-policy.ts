import type { NativeSession } from './runtime.js';

const NESTED_OPERATION_TOOLS = ['delegate_child', 'message_child', 'subagent', 'create-workflow', 'run-workflow', 'create_thread'];
const installedMachinery = new WeakMap<NativeSession, NativeSession['machinery']>();

/** Scope an owned child's Session paths to one native model operation.
 * The shared agent remains background-enabled for its parent. Global external
 * notification wakes bypass this Session seam and are outside this contract.
 * Native shell background processes retain their separate SDK semantics.
 * Call before exposing a recreated child: these native rules are not durable.
 */
export async function applyChildSessionPolicy(child: NativeSession): Promise<void> {
  const original = child.machinery;
  // Repeated application must not stack wrappers. A native machinery replacement
  // needs a fresh wrapper, so remember the installed object rather than a flag.
  if (installedMachinery.get(child) !== original) {
    const machinery = { ...original,
      buildStreamOptions: async (input: Parameters<typeof original.buildStreamOptions>[0]) => ({ ...await original.buildStreamOptions(input), disableBackgroundTasks: true }),
      buildSharedRunOptions: () => ({ ...original.buildSharedRunOptions(), disableBackgroundTasks: true }),
    };
    child.setMachinery(machinery);
    installedMachinery.set(child, machinery);
  }
  for (const toolName of NESTED_OPERATION_TOOLS) await child.permissions.setForTool({ toolName, policy: 'deny' });
}
