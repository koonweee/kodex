import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createTool, SignalProvider, type MastraCodePlugin, type MastraCodePluginContext } from '@mastra/code-sdk/plugin';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';

export interface ExtensionOptions { id: string; name: string; marker: string; trace: string; gate: string }
export class FixtureProvider extends SignalProvider {
  readonly id: string;
  readonly pollInterval = 10;
  polls = 0;
  stopped = false;
  constructor(private context: MastraCodePluginContext, private options: ExtensionOptions) {
    super(); this.id = options.id;
    // Native polling skips empty subscriptions; this fixture never emits signals.
    this.subscribe({ resourceId: context.cwd, threadId: 'fixture-provider-thread' }, 'fixture-poll');
  }
  private report(event: string) {
    appendFileSync(this.options.trace, JSON.stringify({ kind: 'provider', event, marker: this.options.marker, cwd: this.context.cwd }) + '\n');
  }
  override startPolling() { this.report('start'); super.startPolling(); }
  async poll() { this.polls++; if (this.polls === 1) this.report('poll'); }
  override stop() { this.stopped = true; this.report('stop'); super.stop(); }
}

/** Factories allocate contributions for each native manager load, even when the
 * same global entry module is shared by Node's module cache across projects. */
export function fixturePlugin(options: ExtensionOptions): MastraCodePlugin {
  return { id: options.id,
    tools: context => ({ [options.name]: { tool: createTool({ id: options.name, description: 'Record the native caller without selecting a global Session.',
      inputSchema: { type: 'object', properties: { label: { type: 'string' }, held: { type: 'boolean' } }, required: ['label', 'held'], additionalProperties: false },
      execute: async (input, execution) => {
        const { label, held } = input as { label: string; held: boolean };
        const origin = execution.requestContext?.get('controller') as AgentControllerRequestContext<MastraCodeState> | undefined;
        assert.ok(origin?.threadId && origin.resourceId && origin.session?.id);
        assert.equal(context.getController?.()?.id, origin.controllerId);
        assert.equal(origin.getState().projectPath, context.cwd);
        assert.equal(execution.agent?.threadId, origin.threadId);
        assert.equal(execution.agent?.resourceId, origin.resourceId);
        const result = { kind: 'tool', label, marker: options.marker, cwd: context.cwd, scope: context.scope,
          threadId: origin.threadId, resourceId: origin.resourceId, sessionId: origin.session.id,
          activeSession: context.getActiveSession?.()?.identity.getId() ?? null };
        appendFileSync(options.trace, JSON.stringify({ ...result, event: 'entered' }) + '\n');
        if (held) {
          const deadline = Date.now() + 15_000;
          while (!existsSync(options.gate)) {
            if (execution.abortSignal?.aborted || Date.now() > deadline) throw new Error('Fixture gate aborted or timed out');
            await pause(10);
          }
        }
        appendFileSync(options.trace, JSON.stringify({ ...result, event: 'returned' }) + '\n');
        return result;
      },
    }) } }),
    signalProviders: context => [new FixtureProvider(context, options)],
  };
}
