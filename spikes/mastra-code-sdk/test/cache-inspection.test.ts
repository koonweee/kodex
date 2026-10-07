import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeRequest, compareRequestPrefixes } from '../src/cache-inspection.js';

const request = {
  model: 'gpt-6.1-sol', instructions: 'Stable instructions.',
  tools: [{ type: 'function', name: 'view', description: 'Read file.' }, { type: 'function', name: 'execute', description: 'Run command.' }],
  input: [{ role: 'user', content: 'First question.' }, { role: 'assistant', content: 'First answer.' }],
  reasoning: { effort: 'low', summary: 'auto' }, store: false,
  prompt_cache_options: { mode: 'implicit', ttl: '1h' },
};

test('component summaries preserve ordering and compare exact history prefixes without text', () => {
  const before = summarizeRequest(request);
  const after = summarizeRequest({ ...request, input: [...request.input, { role: 'user', content: 'Next question.' }] });
  assert.equal(before.model, 'gpt-6.1-sol');
  assert.equal(before.reasoningEffort, 'low');
  assert.equal(before.store, false);
  assert.equal(before.cache.mode, 'implicit');
  assert.equal(before.cache.ttl, '1h');
  assert.equal(before.inputItems.length, 2);
  assert.equal(before.inputItems[0]?.role, 'user');
  assert.equal(before.tools?.count, 2);
  assert.equal(before.instructions?.hash, after.instructions?.hash);
  assert.equal(before.tools?.hash, after.tools?.hash);
  assert.notEqual(before.root.hash, after.root.hash);
  const compared = compareRequestPrefixes(request, { ...request, input: [...request.input, { role: 'user', content: 'Next question.' }] });
  assert.equal(compared.instructionsEqual, true);
  assert.equal(compared.toolsEqual, true);
  assert.equal(compared.commonLeadingInputItems, 2);
  assert.ok(compared.inputCommonPrefixLength > 0);
  const changedInstructions = compareRequestPrefixes(request, { ...request, instructions: 'Stable instructions. Extra.' });
  assert.equal(changedInstructions.instructionsEqual, false);
  assert.equal(changedInstructions.instructionCommonPrefixLength, request.instructions.length);
  const changedTools = compareRequestPrefixes(request, { ...request, tools: [...request.tools].reverse() });
  assert.equal(changedTools.toolsEqual, false);
  const changedHistory = compareRequestPrefixes(request, { ...request, input: [{ ...request.input[0], content: 'Changed question.' }, request.input[1]] });
  assert.equal(changedHistory.commonLeadingInputItems, 0);
});

test('summaries and comparisons never expose raw content, credentials, identifiers or arbitrary scalar values', () => {
  const secret = 'sk-secret-never-emit-THIS-1234';
  const id = 'resp-private-id-4567';
  const file = '/Users/privateperson/project/private.txt';
  const captured = {
    model: secret, instructions: `${secret} ${file}`, tools: [{ name: secret }],
    input: [{ type: secret, role: secret, id, content: secret }, { type: 'function_call_output', call_id: id, output: file }],
    reasoning: { effort: secret, summary: secret }, store: secret,
    prompt_cache_key: secret, prompt_cache_retention: secret,
    prompt_cache_options: { mode: secret, ttl: secret },
    headers: { authorization: `Bearer ${secret}` }, metadata: { id },
  };
  const summary = summarizeRequest(captured);
  const output = JSON.stringify({ summary, comparison: compareRequestPrefixes(captured, { ...captured, instructions: secret }) });
  for (const raw of [secret, id, file, 'privateperson', 'authorization', 'Bearer']) assert.equal(output.includes(raw), false);
  assert.equal(summary.model, null);
  assert.equal(summary.reasoningEffort, null);
  assert.equal(summary.store, null);
  assert.equal(summary.cache.mode, null);
  assert.equal(summary.cache.ttl, null);
  assert.equal(summary.cache.keyPresent, true);
  assert.equal(summary.inputItems[0]?.role, null);
  assert.equal(summary.inputItems[0]?.type, null);
  assert.equal(summary.inputItems[1]?.type, 'function_call_output');
  assert.match(summary.root.hash, /^[a-f0-9]{64}$/);
  assert.ok(summary.root.length > 0);
});

test('handles absent components and Chat Completions messages without inventing matching prefixes', () => {
  assert.equal(summarizeRequest(null).inputItems.length, 0);
  assert.equal(compareRequestPrefixes({}, {}).commonLeadingInputItems, 0);
  const chat = summarizeRequest({ messages: [{ role: 'system', content: 'System.' }, { role: 'user', content: 'Hello.' }] });
  assert.equal(chat.inputItems.length, 2);
  assert.equal(chat.inputItems[0]?.role, 'system');
  assert.equal(compareRequestPrefixes({ input: 'abc' }, { input: 'abd' }).inputCommonPrefixLength, 2);
});
