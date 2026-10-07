import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { InputProcessor, ProcessInputStepArgs } from '@mastra/core/processors';
import type { NativeSession } from './runtime.js';

export const CHAT_FAST_SETTING = 'kodexFast';
const capturedFast = 'kodex.fast';

/** A fresh native request context per explicit submission. Native queued stream
 * options retain this plain value; changing thread metadata cannot reprice it.
 */
export async function captureChatFastRequestContext(session: NativeSession) {
  const context = await session.machinery.buildRequestContext();
  context.set(capturedFast, (await session.thread.getSetting({ key: CHAT_FAST_SETTING })) === true);
  return context;
}

export function createFastProcessor(enabled: (args: ProcessInputStepArgs) => boolean | Promise<boolean>) {
  return {
    id: 'kodex-openai-fast',
    async processInputStep(args: ProcessInputStepArgs) {
      if (!await enabled(args)) return undefined;
      if (args.model.provider !== 'openai.responses') throw new Error('Fast responses are not supported by this native model.');
      return { providerOptions: { ...args.providerOptions, openai: { ...args.providerOptions?.openai, serviceTier: 'fast' } } };
    },
  } satisfies InputProcessor;
}

/** Native processor state is scoped to one request, including its tool steps.
 * Non-browser native callers capture once when execution starts. Browser Send
 * and Queue must supply the admission-time capture above.
 */
export function createChatFastProcessor() {
  return createFastProcessor(async args => {
    if (typeof args.state.enabled !== 'boolean') {
      const capture = args.requestContext?.get(capturedFast);
      const controller = args.requestContext?.get('controller') as AgentControllerRequestContext | undefined;
      args.state.enabled = typeof capture === 'boolean' ? capture : (await controller?.getThreadSetting?.(CHAT_FAST_SETTING)) === true;
    }
    return args.state.enabled === true;
  });
}
