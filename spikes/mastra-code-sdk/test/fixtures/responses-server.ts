import http from 'node:http';
import { once } from 'node:events';

export interface RecordedResponseRequest {
  body: { model: string; input: Array<{ type?: string; role?: string; content?: unknown; output?: unknown }>; tools?: Array<{ type: string; name: string }> };
  sessionId: string | undefined;
  nativeThreadId: string | undefined;
}

/** Real Responses wire fixture. Records only non-secret test identity headers. */
export async function startResponsesFixture() {
  const requests: RecordedResponseRequest[] = [];
  let release!: () => void;
  const concurrentGate = new Promise<void>(resolve => { release = resolve; });
  let initialRequests = 0;
  let retried = false;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as RecordedResponseRequest['body'];
      const recorded = { body, sessionId: request.headers['session-id'] as string | undefined, nativeThreadId: request.headers['x-thread-id'] as string | undefined };
      requests.push(recorded);
      const user = body.input.findLast(item => item.role === 'user');
      const text = JSON.stringify(user?.content ?? '');
      if (text.includes('RETRY_LEFT') && !retried) {
        retried = true;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Disposable fixture retry', type: 'server_error' } }));
        return;
      }
      if (text.includes('CONCURRENT_')) {
        if (++initialRequests === 2) release();
        await concurrentGate;
      }
      const toolStep = text.includes('READ_MARKER') && body.input.at(-1)?.type !== 'function_call_output';
      const tool = body.tools?.find(item => item.name === 'view');
      if (toolStep && !tool) throw new Error('Missing native view tool');
      const id = `fixture-response-${requests.length}`;
      const item = toolStep
        ? { type: 'function_call', id: `${id}-item`, call_id: `${id}-call`, name: tool!.name, arguments: JSON.stringify({ path: 'marker.txt' }), status: 'completed' }
        : { type: 'message', id: `${id}-item`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: body.input.at(-1)?.type === 'function_call_output' ? `fixture:${body.input.at(-1)?.output}` : 'FIXTURE_OK', annotations: [] }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({ type: 'response.created', response: { id, created_at: 1, model: body.model } });
      emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(toolStep && { arguments: '' }) } });
      if (toolStep) emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
      else emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content![0]!.text });
      emit({ type: 'response.output_item.done', output_index: 0, item });
      emit({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end('Disposable Responses fixture failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests,
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
