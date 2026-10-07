import http from 'node:http';
import { once } from 'node:events';

export interface FixtureRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }>;
  response_format?: { type: string; json_schema?: { schema: Record<string, unknown> } };
  stream?: boolean;
}
export interface FixtureReply {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>;
}
export function lastUserText(request: FixtureRequest): string {
  const message = request.messages.findLast(message => message.role === 'user');
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map(part => typeof part === 'object' && part && 'text' in part ? String(part.text) : '').join('\n');
  return JSON.stringify(message?.content ?? '');
}

/** A local OpenAI-compatible model; the real SDK still owns tools, memory and runs. */
export async function startModelFixture(reply: (request: FixtureRequest, index: number) => FixtureReply | Promise<FixtureReply> = request => ({ text: `fixture:${lastUserText(request)}` })) {
  const requests: FixtureRequest[] = [];
  const waiters: Array<{ predicate: (request: FixtureRequest) => boolean; resolve: (request: FixtureRequest) => void }> = [];
  const holds: Array<{ marker: string; started: () => void; gate: Promise<void>; release: () => void }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'chat' }, { id: 'judge' }] }));
      return;
    }
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw) as FixtureRequest;
      requests.push(input);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.predicate(input)) waiters.splice(i, 1)[0]!.resolve(input);
      const holdIndex = holds.findIndex(hold => lastUserText(input).includes(hold.marker));
      const hold = holdIndex === -1 ? undefined : holds.splice(holdIndex, 1)[0];
      const result = await reply(input, requests.length - 1);
      const toolCalls = result.toolCalls?.map((call, i) => ({ index: i, id: call.id ?? `fixture-tool-${requests.length}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
      const id = `fixture-response-${requests.length}`;
      if (!input.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id, object: 'chat.completion', model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text ?? null, ...(toolCalls && { tool_calls: toolCalls }) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
        hold?.started();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      chunk({ role: 'assistant', content: hold ? `started:${hold.marker}` : result.text ?? '', ...(toolCalls && { tool_calls: toolCalls }) });
      if (hold) {
        hold.started();
        await Promise.race([hold.gate, once(response, 'close')]);
        if (response.destroyed) return;
      }
      chunk({}, toolCalls ? 'tool_calls' : 'stop');
      response.write(`data: ${JSON.stringify({ id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    holdNext(marker: string) {
      let started!: () => void;
      let release!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      holds.push({ marker, started, gate, release });
      return { reached, release };
    },
    waitForRequest(predicate: (request: FixtureRequest) => boolean): Promise<FixtureRequest> {
      const existing = requests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => waiters.push({ predicate, resolve }));
    },
    async close() {
      for (const hold of holds) hold.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
