import { createInterface } from 'node:readline';

// Local protocol fixture: no model, network, credential store or MCP SDK dependency.
const marker = process.argv[2]!;
const toolName = `probe_${marker}`;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result: unknown;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: marker, version: '1' } };
      break;
    case 'ping': result = {}; break;
    case 'tools/list':
      result = { tools: [{ name: toolName, description: `Read ownership marker ${marker}`, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      break;
    case 'tools/call':
      if (request.params.name !== toolName) throw new Error('Unknown fixture tool');
      result = { content: [{ type: 'text', text: marker }] };
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
