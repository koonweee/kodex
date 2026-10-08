import { ORPCError } from '@orpc/server';
import type { ProjectRuntime } from './runtime.js';
import { watchNativeRows } from './native-watch.js';

interface McpSource {
  bindingId: string;
  projectId: string | null;
  projectName: string | null;
  cwd: string;
  mcp: Pick<NonNullable<ProjectRuntime['mcp']>, 'snapshot' | 'reload'> | undefined;
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
  return {
    list,
    watch(signal?: AbortSignal) {
      return watchNativeRows(list, signal ? AbortSignal.any([signal, options.signal]) : options.signal);
    },
    async reload(input: { bindingId?: string }, signal?: AbortSignal) {
      const waiting = signal ? AbortSignal.any([signal, options.signal]) : options.signal;
      const abandoned = () => new ORPCError('SERVICE_UNAVAILABLE', { message: 'The client is no longer waiting for MCP reload.' });
      if (waiting.aborted) throw abandoned();
      options.assertActive();
      const sources = await options.sources();
      const selected = input.bindingId === undefined ? sources : sources.filter(source => source.bindingId === input.bindingId);
      if (input.bindingId !== undefined && !selected.length) throw new ORPCError('NOT_FOUND', { message: 'MCP runtime binding not found.' });
      options.assertActive();
      if (waiting.aborted) throw abandoned();
      const pending = Promise.all(selected.map(async source => {
        if (!source.mcp) return { bindingId: source.bindingId, error: 'MCP is disabled for this runtime.' };
        try { await source.mcp.reload(); return { bindingId: source.bindingId, error: null }; }
        catch { return { bindingId: source.bindingId, error: 'MCP reload failed.' }; }
      }));
      // Transport closure abandons this response only. The retained native
      // manager still owns its operation; shutdown must not wait on this RPC.
      return new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const abort = () => { waiting.removeEventListener('abort', abort); reject(abandoned()); };
        waiting.addEventListener('abort', abort, { once: true });
        if (waiting.aborted) abort();
        pending.then(result => { waiting.removeEventListener('abort', abort); resolve(result); },
          error => { waiting.removeEventListener('abort', abort); reject(error); });
      });
    },
  };
}
export type McpService = ReturnType<typeof createMcpService>;
