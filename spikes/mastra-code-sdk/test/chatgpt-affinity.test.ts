import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { createChatGptAffinityProcessor } from '../src/chatgpt-affinity.js';

function args(threadId: unknown, options: { provider?: string; oauth?: boolean; step?: number; retry?: number; settings?: ProcessInputStepArgs['modelSettings'] } = {}): ProcessInputStepArgs {
  const requestContext = new RequestContext();
  requestContext.set('controller', { threadId, resourceId: 'must-not-be-the-affinity-id' });
  requestContext.set('nativeOAuth', options.oauth ?? true);
  return { requestContext, model: { provider: options.provider ?? 'openai.responses', modelId: 'gpt-6.1-sol' }, stepNumber: options.step ?? 0, retryCount: options.retry ?? 0, modelSettings: options.settings } as ProcessInputStepArgs;
}
const processor = createChatGptAffinityProcessor({ isNativeCodexModel: context => context.model.provider === 'openai.responses' && context.requestContext?.get('nativeOAuth') === true });

test('merges authoritative thread affinity while preserving settings and unrelated headers without mutation', () => {
  const headers = Object.freeze({ authorization: 'existing-native-auth', 'x-thread-id': 'thread-A', 'Session-Id': 'stale', 'SESSION-ID': 'also-stale', 'x-custom': 'keep', 'x-optional': undefined });
  const settings = Object.freeze({ temperature: 0.3, maxRetries: 2, headers });
  const result = processor.processInputStep(args('thread-A', { settings }));
  assert.equal(result?.modelSettings?.temperature, 0.3);
  assert.equal(result?.modelSettings?.maxRetries, 2);
  assert.deepEqual(result?.modelSettings?.headers, { authorization: 'existing-native-auth', 'x-thread-id': 'thread-A', 'x-custom': 'keep', 'x-optional': undefined, 'session-id': 'thread-A' });
  assert.equal(headers['Session-Id'], 'stale');
  assert.notEqual(result?.modelSettings, settings);
  assert.notEqual(result?.modelSettings?.headers, headers);
});

test('thread identity is stable across turns, tool steps, retries and reconstructed contexts', () => {
  for (const context of [args('thread-A'), args('thread-A', { step: 1 }), args('thread-A', { retry: 2 }), args('thread-A')]) {
    assert.equal(processor.processInputStep(context)?.modelSettings?.headers?.['session-id'], 'thread-A');
  }
});

test('concurrent independent contexts retain distinct native thread identities', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve(processor.processInputStep(args(`thread-${index}`)))));
  assert.deepEqual(results.map(result => result?.modelSettings?.headers?.['session-id']), Array.from({ length: 20 }, (_, index) => `thread-${index}`));
});

test('does not add affinity to API-key or other-provider models, or when native identity is missing/unsafe', () => {
  assert.equal(processor.processInputStep(args('thread-A', { oauth: false })), undefined);
  for (const provider of ['openai.chat', 'anthropic.messages', 'fixture.chat']) assert.equal(processor.processInputStep(args('thread-A', { provider })), undefined);
  for (const missing of [undefined, null, '', ' ', 123, 'thread\r\ninjected: value']) assert.equal(processor.processInputStep(args(missing)), undefined);
  const missingController = args('thread-A');
  missingController.requestContext!.set('controller', undefined);
  assert.equal(processor.processInputStep(missingController), undefined);
  assert.equal(processor.processInputStep({ ...args("thread-A"), requestContext: undefined }), undefined);
});
