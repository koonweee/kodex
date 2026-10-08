import { os } from '@orpc/server';
import { inputSchema } from './rpc-input.js';
import type { TerminalCreate, TerminalService } from './terminal-service.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const createInput = inputSchema<TerminalCreate>(value => object(value)
  && Object.keys(value).every(key => ['projectId', 'cwd', 'command', 'title'].includes(key))
  && Object.entries(value).every(([key, field]) => typeof field === 'string' && field.length <= (key === 'projectId' ? 256 : 4096) && !field.includes('\0') && (key !== 'projectId' || field.trim().length > 0)));
const deleteInput = inputSchema<{ terminalId: string }>(value => object(value) && Object.keys(value).length === 1
  && typeof value.terminalId === 'string' && value.terminalId.length > 0 && value.terminalId.length <= 256);
export function createTerminalRouter(service: TerminalService) {
  return {
    listTerminals: os.handler(() => service.list()),
    createTerminal: os.input(createInput).handler(({ input }) => service.create(input)),
    deleteTerminal: os.input(deleteInput).handler(({ input }) => service.delete(input.terminalId)),
  };
}
