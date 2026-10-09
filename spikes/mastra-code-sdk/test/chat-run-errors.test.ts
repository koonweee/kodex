import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNativeRetry, logChatRunError } from '../src/chat-run-errors.js';

test('native recovery includes its last retry; terminal events remain failures', () => {
  assert.equal(isNativeRetry({ error: new Error(), retryable: true, retryAttempt: 3, maxRetries: 3 }), true);
  assert.equal(isNativeRetry({ error: new Error(), retryable: false }), false);
  assert.equal(isNativeRetry({ error: new Error() }), false);
});

test('diagnostics correlate errors and retries without serializing request secrets', () => {
  const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  const error = Object.assign(new Error('Unavailable Bearer secret-token https://provider.test/?key=secret-key\nrequest body secret-body', { cause }), {
    statusCode: 503, requestBodyValues: { secret: 'secret-body' }, responseHeaders: { authorization: 'secret-header' },
  });
  const lines: string[] = [];
  logChatRunError('chat-id', { error, retryable: true, retryAttempt: 2, maxRetries: 3, retryDelay: 100 }, line => lines.push(line));
  const record = JSON.parse(lines[0]!);
  assert.equal(record.chatId, 'chat-id');
  assert.equal(record.retrying, true);
  assert.equal(record.retryAttempt, 2);
  assert.equal(record.causes[0].status, 503);
  assert.equal(record.causes[1].code, 'ECONNRESET');
  assert.equal(record.causes[1].message, 'socket closed');
  assert.doesNotMatch(lines[0]!, /secret-token|secret-key|secret-body|secret-header/);
});

test('diagnostics bound cyclic causes and redact common credential formats', () => {
  const error = Object.assign(new Error('api_key=private sk-private eyJprivate'), { cause: undefined as unknown });
  error.cause = error;
  logChatRunError('chat-id', { error }, line => {
    assert.equal(JSON.parse(line).causes.length, 1);
    assert.doesNotMatch(line, /private/);
  });
});


test('diagnostics remove Basic authorization and spaced credential labels', () => {
  const error = new Error('Authorization: Basic dXNlcjpwYXNz; api key=private-token');
  logChatRunError('chat-id', { error, errorType: 'network', finishReason: 'error' }, line => {
    assert.doesNotMatch(line, /dXNlcjpwYXNz|private-token/);
    assert.equal(JSON.parse(line).errorType, 'network');
    assert.equal(JSON.parse(line).finishReason, 'error');
  });
});
