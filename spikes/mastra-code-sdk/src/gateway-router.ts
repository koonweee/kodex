import { createPushRouter } from './push-router.js';
import { createMcpRouter } from './mcp-router.js';
import { createAutomationRouter } from './automation-router.js';
import { createChatRouter } from './chat-router.js';
import type { ChatService } from './chat-service.js';
import { createTerminalRouter } from './terminal-router.js';
import type { TerminalService } from './terminal-service.js';

export function createGatewayRouter(chats: ChatService, terminals: TerminalService) {
  return { push: createPushRouter(chats.push), ...createChatRouter(chats), ...createMcpRouter(chats.mcp), ...createTerminalRouter(terminals), ...createAutomationRouter(chats.automations) };
}
export type GatewayRouter = ReturnType<typeof createGatewayRouter>;
