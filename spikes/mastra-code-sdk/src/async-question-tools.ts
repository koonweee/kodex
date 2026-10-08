import { createTool } from '@mastra/core/tools';

/** Questions are native saved tool calls; answering is a separate user signal. */
export function createAsyncQuestionTools() {
  return {
    request_user_input_async: createTool({
      id: 'request_user_input_async',
      description: 'Ask the user one or more questions and continue working immediately. The user may reply later. Supply options for choices, or omit options for free text.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['questions'],
        properties: {
          questions: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false, required: ['title'],
              properties: {
                title: { type: 'string', pattern: '\\S' },
                // Frozen main treats null like omission, so native validation does too.
                options: { type: ['array', 'null'], minItems: 1, items: { type: 'string', pattern: '\\S' } },
              },
            },
          },
        },
      },
      execute: async () => ({ accepted: true }),
    }),
  };
}
