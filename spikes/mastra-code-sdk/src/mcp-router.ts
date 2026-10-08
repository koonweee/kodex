import { os } from '@orpc/server';
import type { McpService } from './mcp-service.js';
import { inputSchema } from './rpc-input.js';

const reloadInput = inputSchema<{ bindingId?: string }>(value => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).every(key => key === 'bindingId')
  && (!('bindingId' in value) || typeof value.bindingId === 'string' && value.bindingId.length > 0 && value.bindingId.length <= 512));
export function createMcpRouter(service: McpService) {
  return {
    nativeMcpList: os.handler(() => service.list()),
    nativeMcpWatch: os.handler(({ signal }) => service.watch(signal)),
    nativeMcpReload: os.input(reloadInput).handler(({ input, signal }) => service.reload(input, signal)),
  };
}
