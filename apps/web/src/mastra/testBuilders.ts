import type { ChatSnapshot } from './client';

export function nativeSettingsFixture(modelId = 'openai-codex/gpt-5.4', thinkingLevel: ChatSnapshot['settings']['thinkingLevel'] = 'medium'): ChatSnapshot['settings'] {
  return { modelId, thinkingLevel, fast: false, thinkingLevelOverride: null, thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] };
}

export function nativeQueueFixture(epoch = 'epoch'): ChatSnapshot['queue'] {
  return { epoch, revision: 0, rows: [], nativeCount: 0, partial: false };
}
