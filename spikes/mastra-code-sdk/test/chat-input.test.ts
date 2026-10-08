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
