import { LocalFilesystem } from '@mastra/core/workspace';
import { parse } from 'node:path';
import type { AgentController } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';

/** Keep the SDK workspace/tools and native thread settings. The filesystem
 * accepts a root grant; the separate request_access tool does not recognize it
 * consistently and is disabled by the runtime because no approval is needed. */
export function installFilesystemAccess(controller: AgentController<MastraCodeState>, projectPath: string) {
  const allowedPaths = [parse(projectPath).root];
  return controller.onSessionCreated(async session => {
    // Persist first, so native reopen/wake/fork state restores the same policy.
    await session.thread.setSetting({ key: 'sandboxAllowedPaths', value: allowedPaths });
    await session.state.set({ sandboxAllowedPaths: allowedPaths });
    const filesystem = session.getWorkspace()?.filesystem;
    if (filesystem instanceof LocalFilesystem) filesystem.setAllowedPaths(allowedPaths);
  }, { blocking: true });
}
