import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Local protocol/process fixture. No network, model, credentials or exit override.
const [mode, tracePath] = process.argv.slice(2);
const trace = (event: string, details: Record<string, unknown> = {}) => appendFileSync(tracePath!, `${JSON.stringify({ pid: process.pid, at: Date.now(), event, ...details })}\n`);
trace('started');
const lines = createInterface({ input: process.stdin });
lines.on('close', () => trace('stdin-closed'));
process.on('exit', code => trace('exit', { code }));
lines.on('line', line => {
  const request = JSON.parse(line);
  trace('request', { method: request.method });
  if (mode === 'silent-discovery' || (mode === 'silent-initialize' && request.method === 'initialize') || request.id === undefined) return;
  let result: unknown;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lifecycle', version: '1' } };
      break;
    case 'ping': result = {}; break;
    case 'tools/list':
      result = { tools: [{ name: 'probe_lifecycle', description: 'Return a local lifecycle witness', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      break;
    case 'tools/call': result = { content: [{ type: 'text', text: 'NATIVE_MCP_LIFECYCLE' }] }; break;
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
      return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
