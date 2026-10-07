import type { InputProcessor, ProcessInputStepArgs, ProcessInputStepResult } from '@mastra/core/processors';

export interface ChatGptAffinityOptions {
  /** Bind to the native credential resolver for the mounted profile. Provider
   * metadata alone cannot distinguish ChatGPT OAuth from ordinary OpenAI API.
   */
  isNativeCodexModel: (args: ProcessInputStepArgs) => boolean;
}

/** A stateless native input processor: affinity belongs to the persisted thread,
 * never the process/controller/session instance, run, tool step or retry.
 */
export function createChatGptAffinityProcessor(options: ChatGptAffinityOptions) {
  return {
    id: 'kodex-chatgpt-thread-affinity',
    processInputStep(args: ProcessInputStepArgs): ProcessInputStepResult | undefined {
      const controller = args.requestContext?.get('controller') as { threadId?: unknown } | undefined;
      const threadId = controller?.threadId;
      if (typeof threadId !== 'string' || !threadId.length || /[^\x21-\x7e]/.test(threadId)) return undefined;
      if (!options.isNativeCodexModel(args)) return undefined;
      const headers = { ...args.modelSettings?.headers };
      // Header names are case-insensitive. Leaving a differently cased old value
      // would combine identities when the HTTP provider builds its Headers.
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'session-id') delete headers[name];
      headers['session-id'] = threadId;
      return { modelSettings: { ...args.modelSettings, headers } };
    },
  } satisfies InputProcessor;
}
