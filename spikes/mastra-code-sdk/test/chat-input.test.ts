import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareChatInput } from '../src/chat-input.js';

const file = { id: 'upload', fileName: 'notes.md', extension: 'md', relativePath: '.kodex/uploads/chat/upload/notes.md', absolutePath: '/untrusted/path', mimeType: 'text/markdown', sizeBytes: 5 };
test('native file composition retains text and canonical relative references without trusting absolute paths', async () => {
  const result = await prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: 'Read <notes> & report.', files: [{ ...file, unexpected: { unvalidated: true } } as typeof file] } });
  assert.equal(result.contents, 'Read <notes> & report.\n\n```kodex-attachments\n- .kodex/uploads/chat/upload/notes.md\n```');
  assert.deepEqual(result.metadata?.kodexAttachments, [{ ...file, absolutePath: undefined }]);
  assert.equal(JSON.stringify(result).includes('/untrusted/path'), false);
  assert.equal(file.absolutePath, '/untrusted/path', 'caller input is untouched');
});
test('file-only submissions are native input and empty submissions are rejected', async () => {
  const result = await prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: '', files: [file] } });
  assert.equal(result.contents, '```kodex-attachments\n- .kodex/uploads/chat/upload/notes.md\n```');
  await assert.rejects(prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: ' ' } }), { code: 'BAD_REQUEST' });
});
test('file references cannot target another chat or inject a malformed attachment envelope', async () => {
  for (const relativePath of ['.kodex/uploads/other/upload/notes.md', '.kodex/uploads/chat/../notes.md', '/tmp/notes.md', '.kodex/uploads/chat/upload/notes.md\n```', '.kodex/uploads/chat//notes.md']) {
    await assert.rejects(prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: 'Read', files: [{ ...file, relativePath }] } }), { code: 'BAD_REQUEST' });
  }
});

test('explicit native skills expand model input while owned metadata preserves original display text and bindings', async () => {
  const selected = { name: 'review', path: '/project/.agents/skills/review' };
  const mention = { ...selected, start: 4, end: 11 };
  const result = await prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: 'Use $review', skills: [selected], skillMentions: [mention], files: [file] },
    prepareSkills: async refs => { assert.deepEqual(refs, [selected]); return { references: [selected], activation: '<skill>Native formatted instructions</skill>' }; },
  });
  assert.match(String(result.contents), /Native formatted instructions/);
  assert.match(String(result.contents), /kodex-attachments/);
  assert.deepEqual(result.metadata?.kodexSkillInput, { text: 'Use $review', skills: [selected], mentions: [mention] });
  assert.ok(result.metadata?.kodexAttachments);
});

test('skill preparation is required and malformed or unbound display spans reject before submission', async () => {
  const selected = { name: 'review', path: '/project/.agents/skills/review' };
  await assert.rejects(prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: '$review', skills: [selected] } }), { code: 'BAD_REQUEST' });
  for (const mention of [{ ...selected, start: 0, end: 100 }, { ...selected, start: 0, end: 6 }, { ...selected, start: 0, end: 7, path: '/other' }]) {
    await assert.rejects(prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: '$review', skills: [selected], skillMentions: [mention] },
      prepareSkills: async () => ({ references: [selected], activation: 'native' }) }), { code: 'BAD_REQUEST' });
  }
});


test('overlapping skill highlights cannot create native metadata that the timeline cannot project', async () => {
  const selected = { name: 'review', path: '/project/.agents/skills/review' };
  const mention = { ...selected, start: 0, end: 7 };
  await assert.rejects(prepareChatInput({ chatId: 'chat', imageRoot: '/unused', input: { text: '$review', skills: [selected], skillMentions: [mention, mention] },
    prepareSkills: async () => ({ references: [selected], activation: 'native' }) }), { code: 'BAD_REQUEST' });
});
