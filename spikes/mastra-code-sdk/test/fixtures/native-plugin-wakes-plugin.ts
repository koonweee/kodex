import { appendFileSync } from 'node:fs';
import { createTool, SignalProvider, type SignalProviderTarget, type MastraCodePlugin } from '@mastra/code-sdk/plugin';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';

export class WakeProvider extends SignalProvider {
  readonly id = 'fixture-wakes';
  readonly pollInterval = 10;
  starts = 0; polls = 0; notifications = 0;
  constructor(private target?: SignalProviderTarget) {
    super();
    if (target) this.subscribe(target, 'automatic-proof-notification');
  }
  override startPolling() { this.starts++; super.startPolling(); }
  async poll() { this.polls++; if (this.target && this.notifications === 0) await this.fire(this.target, 'automatic-provider'); }
  override async notify(...args: Parameters<SignalProvider['notify']>) { this.notifications++; return super.notify(...args); }
  async fire(target: SignalProviderTarget, label: string) {
    await this.notify({ source: this.id, kind: 'fixture-probe', priority: 'urgent', summary: `WAKE_PROBE:${label}` }, target);
  }
}
export function wakePlugin(trace: string, marker = 'v1', providerTarget?: SignalProviderTarget): MastraCodePlugin {
  return { id: 'wake-proof', signalProviders: () => [new WakeProvider(providerTarget)], tools: () => ({ wake_probe: {
    tool: createTool({ id: 'wake_probe', description: 'Record the actual native tool origin and background adoption.',
      inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
      background: { enabled: true, defaultDisposition: 'foreground', maxRetries: 0, timeoutMs: 10_000 },
      execute: async (input, execution) => {
        const origin = execution.requestContext?.get('controller') as AgentControllerRequestContext<MastraCodeState> | undefined;
        const result = { marker, label: (input as { label: string }).label, threadId: origin?.threadId ?? null, resourceId: origin?.resourceId ?? null,
          projectPath: origin?.getState().projectPath ?? null, sessionId: origin?.session?.id ?? null,
          backgroundTaskId: execution.background?.taskId ?? null, text: `PROBE_RESULT:${(input as { label: string }).label}` };
        appendFileSync(trace, JSON.stringify(result) + '\n');
        return result;
      },
    }),
  } }) };
}
