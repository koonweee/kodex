import type { McpManager } from '@mastra/code-sdk/mcp/manager';
import type { McpServerStatus } from '@mastra/code-sdk/mcp/types';

export interface RuntimeMcpSnapshot {
  phase: 'initializing' | 'reloading' | 'ready' | 'failed';
  servers: McpServerStatus[];
  skipped: Array<{ name: string; reason: string }>;
  paths: ReturnType<McpManager['getConfigPaths']>;
}
type NativeMcpManager = Pick<McpManager, 'initInBackground' | 'reload' | 'disconnect' | 'getServerStatuses' | 'getSkippedServers' | 'getConfigPaths' | 'setServerDisabled' | 'inheritServer'>;

/** Transient admission/operation state around one retained native manager.
 * Native discovery owns server status and tools. Disconnect is not an init
 * producer join; backend entrypoint shutdown owns the final process exit. */
export function createRuntimeMcp(manager: NativeMcpManager) {
  let phase: RuntimeMcpSnapshot['phase'] = 'initializing';
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const assertOpen = () => { if (disposed) throw new Error('Runtime MCP is disposed.'); };
  const ready = (async () => {
    try { await manager.initInBackground(); phase = 'ready'; }
    catch { phase = 'failed'; }
  })();
  let tail: Promise<void> = ready;
  function mutate(run: () => Promise<unknown>, serverName?: string): Promise<void> {
    if (disposed) return Promise.reject(new Error('Runtime MCP is disposed.'));
    const operation = tail.then(async () => {
      assertOpen();
      // A prior reload may add/remove this server. Validate only at dispatch,
      // using native inventory rather than retaining config or status state.
      if (serverName !== undefined && !manager.getServerStatuses().some(server => server.name === serverName)) {
        throw new Error('MCP server not found.');
      }
      phase = 'reloading';
      try { await run(); phase = 'ready'; }
      catch { phase = 'failed'; throw new Error('MCP operation failed.'); }
    });
    // A failed explicit operation must not poison the next explicit attempt.
    tail = operation.catch(() => {});
    return operation;
  }
  return {
    ready,
    snapshot(): RuntimeMcpSnapshot {
      assertOpen();
      const servers = manager.getServerStatuses().map(server => ({
        name: server.name, connected: server.connected, toolCount: server.toolCount,
        toolNames: [...server.toolNames], transport: server.transport,
        ...(server.connecting !== undefined && { connecting: server.connecting }),
        ...(server.disabled !== undefined && { disabled: server.disabled }),
        ...(server.disabledScope !== undefined && { disabledScope: server.disabledScope }),
        ...(server.needsAuth !== undefined && { needsAuth: server.needsAuth }),
        ...(server.authenticating !== undefined && { authenticating: server.authenticating }),
        ...(server.cancelled !== undefined && { cancelled: server.cancelled }),
        ...(server.projectOverride !== undefined && { projectOverride: server.projectOverride }),
        ...(server.globalDefault !== undefined && { globalDefault: server.globalDefault }),
        ...(server.globalKillSwitch !== undefined && { globalKillSwitch: server.globalKillSwitch }),
        ...(server.error !== undefined && { error: 'MCP server connection failed.' }),
      }));
      const paths = manager.getConfigPaths();
      return { phase, servers,
        skipped: manager.getSkippedServers().map(server => ({ name: server.name, reason: 'MCP server configuration was skipped.' })),
        paths: { project: paths.project, global: paths.global, claude: paths.claude },
      };
    },
    reload(): Promise<void> { return mutate(() => manager.reload()); },
    setServerEnabled(name: string, enabled: boolean): Promise<void> {
      return mutate(() => manager.setServerDisabled(name, !enabled), name);
    },
    inheritServer(name: string): Promise<void> { return mutate(() => manager.inheritServer(name), name); },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      // Close admission synchronously. Do not await ready/tail: silent native
      // initialization can remain pending and retry after disconnect returns.
      disposal = manager.disconnect();
      return disposal;
    },
  };
}
