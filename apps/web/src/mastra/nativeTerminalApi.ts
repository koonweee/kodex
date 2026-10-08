import type { TerminalSessionApi } from '../terminal/useGatewayTerminalSession';
import { mastraClient } from './client';

export const nativeTerminalApi: TerminalSessionApi = {
  list: () => mastraClient.listTerminals(),
  create: (input = {}) => mastraClient.createTerminal({
    ...(input.command != null ? { command: input.command } : {}),
    ...(input.cwd != null ? { cwd: input.cwd } : {}),
    ...(input.projectId != null ? { projectId: input.projectId } : {}),
    ...(input.title != null ? { title: input.title } : {}),
  }),
  delete: terminalId => mastraClient.deleteTerminal({ terminalId }),
};
