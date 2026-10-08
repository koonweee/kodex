import { createChatRouter } from './chat-router.js';
import type { ChatService } from './chat-service.js';
import { createTerminalRouter } from './terminal-router.js';
import type { TerminalService } from './terminal-service.js';

export function createGatewayRouter(chats: ChatService, terminals: TerminalService) {
  return { ...createChatRouter(chats), ...createTerminalRouter(terminals) };
}
export type GatewayRouter = ReturnType<typeof createGatewayRouter>;
