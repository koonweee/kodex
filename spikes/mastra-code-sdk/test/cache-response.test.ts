import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCacheResult } from '../src/cache-response.js';

function streamed(text: string, width = 1): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.slice(offset, offset + width));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const data = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const completed = (details: Record<string, unknown> = {}) => ({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 101, output_tokens: 7, input_tokens_details: { cached_tokens: 80, ...details } } } });

test('reads split UTF-8 SSE chunks and terminal usage, without inventing cache-write usage', async () => {
  const response = streamed(data({ type: 'response.output_text.delta', delta: '✓' }) + data({ type: 'response.output_text.delta', delta: ' OK' }) + data(completed()) + 'data: [DONE]\r\n\r\n');
  const result = await readCacheResult(response, performance.now(), '✓ OK');
  assert.equal(result.completed, true);
  assert.equal(result.correct, true);
  assert.equal(result.input, 101);
  assert.equal(result.output, 7);
  assert.equal(result.cached, 80);
  assert.equal(result.cacheWrite, null);
  assert.ok(result.elapsedMs >= 0);
  for (const field of ['cache_creation_tokens', 'cache_write_tokens']) {
    const withWrite = await readCacheResult(streamed(data({ type: 'response.output_text.delta', delta: 'CACHE_PROBE_OK' }) + data(completed({ [field]: 12 }))), performance.now());
    assert.equal(withWrite.cacheWrite, 12, 'only an explicitly reported numeric provider field becomes cache-write usage');
  }
});

test('handles multiline data frames and an unterminated final event; incorrect answers stay false', async () => {
  const text = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"WRONG_PRIVATE_ANSWER"}\n\n' + `data: ${JSON.stringify(completed({ cached_tokens: 'SECRET_USAGE' }))}`;
  const result = await readCacheResult(streamed(text, 13), performance.now());
  assert.equal(result.completed, true);
  assert.equal(result.correct, false);
  assert.equal(result.cached, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('HTTP errors, provider terminal errors, incomplete streams and malformed data never become successful probes', async () => {
  const secret = 'RAW_PROVIDER_CREDENTIAL_AND_REQUEST_SECRET';
  const httpError = await readCacheResult(new Response(secret, { status: 401 }), performance.now());
  assert.equal(httpError.status, 401);
  assert.equal(httpError.completed, false);
  assert.equal(httpError.correct, false);
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    const result = await readCacheResult(streamed(data({ type: 'response.output_text.delta', delta: 'CACHE_PROBE_OK' }) + data(completed()) + data({ type, error: { message: secret } })), performance.now());
    assert.equal(result.completed, false);
    assert.equal(result.correct, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const truncated = await readCacheResult(streamed(data({ type: 'response.output_text.delta', delta: 'CACHE_PROBE_OK' }) + 'data: {BAD_JSON_SECRET}\n\n'), performance.now());
  assert.equal(truncated.completed, false);
  assert.equal(truncated.correct, false);
});

test('suppresses raw stream failures and safely handles a bodyless response', async () => {
  const secret = 'RAW_STREAM_FAILURE_SECRET';
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }));
  const result = await readCacheResult(broken, performance.now());
  assert.equal(result.completed, false);
  assert.equal(result.correct, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await readCacheResult(new Response(null, { status: 204 }), performance.now())).completed, false);
});
