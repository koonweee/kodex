import { ORPCError } from '@orpc/server';
import type { ProjectRuntime } from './runtime.js';
import { watchNativeRows } from './native-watch.js';

interface McpSource {
  bindingId: string;
  projectId: string | null;
  projectName: string | null;
  cwd: string;
  mcp: Pick<NonNullable<ProjectRuntime['mcp']>, 'snapshot' | 'reload' | 'setServerEnabled' | 'inheritServer' | 'authenticateServer' | 'cancelServerAuthentication'> | undefined;
}
export function createMcpService(options: {
  sources: () => Promise<McpSource[]>;
  assertActive: () => void;
  signal: AbortSignal;
}) {
  async function list() {
    options.assertActive();
    const sources = await options.sources();
    options.assertActive();
    return sources.map(({ mcp, ...identity }) => ({ ...identity,
      ...(mcp?.snapshot() ?? { phase: 'disabled' as const, servers: [], skipped: [], paths: null }),
    }));
  }
  function command<T>(run: (assertWaiting: () => void) => Promise<T>, signal?: AbortSignal) {
    const waiting = signal ? AbortSignal.any([signal, options.signal]) : options.signal;
    const abandoned = () => new ORPCError('SERVICE_UNAVAILABLE', { message: 'The client is no longer waiting for the MCP operation.' });
    const assertWaiting = () => { if (waiting.aborted) throw abandoned(); options.assertActive(); };
    // Observe all late settlement; closing transport abandons only the response.
    const pending = Promise.resolve().then(() => { assertWaiting(); return run(assertWaiting); });
    return new Promise<T>((resolve, reject) => {
      const abort = () => { waiting.removeEventListener('abort', abort); reject(abandoned()); };
      waiting.addEventListener('abort', abort, { once: true });
      if (waiting.aborted) abort();
      pending.then(result => { waiting.removeEventListener('abort', abort); resolve(result); },
        error => { waiting.removeEventListener('abort', abort); reject(error); });
    });
  }
  async function reloadSource(source: McpSource) {
    if (!source.mcp) return { bindingId: source.bindingId, error: 'MCP is disabled for this runtime.' };
    try { await source.mcp.reload(); return { bindingId: source.bindingId, error: null }; }
    catch { return { bindingId: source.bindingId, error: 'MCP reload failed.' }; }
  }
  async function findTarget(input: { bindingId: string }, assertWaiting: () => void) {
    const sources = await options.sources();
    assertWaiting();
    const target = sources.find(source => source.bindingId === input.bindingId);
    if (!target) throw new ORPCError('NOT_FOUND', { message: 'MCP runtime binding not found.' });
    if (!target.mcp) throw new ORPCError('BAD_REQUEST', { message: 'MCP is disabled for this runtime.' });
    return { sources, target, mcp: target.mcp };
  }
  function projectCommand(input: { bindingId: string; server: string }, mutate: (mcp: NonNullable<McpSource['mcp']>) => Promise<void>, signal?: AbortSignal) {
    return command(async assertWaiting => {
      const { sources, target, mcp } = await findTarget(input, assertWaiting);
      // The native detected project root owns override state. Different cwd
      // bindings can share that root; the native primary path identifies it.
      const path = mcp.snapshot().paths.project;
      const peers = sources.filter(source => source !== target && source.mcp?.snapshot().paths.project === path);
      let error: string | null = null;
      try { await mutate(mcp); } catch { error = 'MCP server setting could not be applied.'; }
      // A native write may succeed before connection rebuilding fails. Refill
      // peers even in that case; never retry the write or mirror its state.
      return [{ bindingId: target.bindingId, error }, ...await Promise.all(peers.map(reloadSource))];
    }, signal);
  }
  return {
    list,
    watch(signal?: AbortSignal) {
      return watchNativeRows(list, signal ? AbortSignal.any([signal, options.signal]) : options.signal);
    },
    reload(input: { bindingId?: string }, signal?: AbortSignal) {
      return command(async assertWaiting => {
        const sources = await options.sources();
        const selected = input.bindingId === undefined ? sources : sources.filter(source => source.bindingId === input.bindingId);
        if (input.bindingId !== undefined && !selected.length) throw new ORPCError('NOT_FOUND', { message: 'MCP runtime binding not found.' });
        assertWaiting();
        return Promise.all(selected.map(reloadSource));
      }, signal);
    },
    authenticateServer(input: { bindingId: string; server: string }, signal?: AbortSignal) {
      return command(async assertWaiting => {
        const { mcp } = await findTarget(input, assertWaiting);
        return mcp.authenticateServer(input.server);
      }, signal);
    },
    cancelServerAuthentication(input: { bindingId: string; server: string }, signal?: AbortSignal) {
      return command(async assertWaiting => {
        const { mcp } = await findTarget(input, assertWaiting);
        return mcp.cancelServerAuthentication(input.server);
      }, signal);
    },
    setServerEnabled(input: { bindingId: string; server: string; enabled: boolean }, signal?: AbortSignal) {
      return projectCommand(input, mcp => mcp.setServerEnabled(input.server, input.enabled), signal);
    },
    inheritServer(input: { bindingId: string; server: string }, signal?: AbortSignal) {
      return projectCommand(input, mcp => mcp.inheritServer(input.server), signal);
    },
  };
}
export type McpService = ReturnType<typeof createMcpService>;
