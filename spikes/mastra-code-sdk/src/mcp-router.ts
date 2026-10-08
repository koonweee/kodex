import { os } from '@orpc/server';
import type { McpService } from './mcp-service.js';
import { inputSchema } from './rpc-input.js';

const reloadInput = inputSchema<{ bindingId?: string }>(value => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).every(key => key === 'bindingId')
  && (!('bindingId' in value) || typeof value.bindingId === 'string' && value.bindingId.length > 0 && value.bindingId.length <= 512));
const serverTarget = (value: unknown): value is { bindingId: string; server: string } => typeof value === 'object' && value !== null && !Array.isArray(value)
  && 'bindingId' in value && typeof value.bindingId === 'string' && value.bindingId.length > 0 && value.bindingId.length <= 512
  && 'server' in value && typeof value.server === 'string' && value.server.length > 0 && value.server.length <= 512;
const enabledInput = inputSchema<{ bindingId: string; server: string; enabled: boolean }>(value => serverTarget(value)
  && Object.keys(value).length === 3 && 'enabled' in value && typeof value.enabled === 'boolean');
const targetInput = inputSchema<{ bindingId: string; server: string }>(value => serverTarget(value) && Object.keys(value).length === 2);
export function createMcpRouter(service: McpService) {
  return {
    nativeMcpAuthenticate: os.input(targetInput).handler(({ input, signal }) => service.authenticateServer(input, signal)),
    nativeMcpCancelAuthentication: os.input(targetInput).handler(({ input, signal }) => service.cancelServerAuthentication(input, signal)),
    nativeMcpSetServerEnabled: os.input(enabledInput).handler(({ input, signal }) => service.setServerEnabled(input, signal)),
    nativeMcpInheritServer: os.input(targetInput).handler(({ input, signal }) => service.inheritServer(input, signal)),
    nativeMcpList: os.handler(() => service.list()),
    nativeMcpWatch: os.handler(({ signal }) => service.watch(signal)),
    nativeMcpReload: os.input(reloadInput).handler(({ input, signal }) => service.reload(input, signal)),
  };
}
