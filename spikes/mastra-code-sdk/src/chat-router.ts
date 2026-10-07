import { eventIterator, os, type as schemaType } from '@orpc/server';
import type { CatalogSnapshot, ChatService, ChatSnapshot } from './chat-service.js';

/** A small actual Standard Schema validator: types alone do not validate RPC
 * requests. Reject unknown fields so the client cannot supply runtime settings.
 */
function objectInput<T extends Record<string, string>>(keys: readonly (keyof T & string)[]) {
  const standard: {
    version: 1; vendor: string; types?: { input: T; output: T };
    validate(value: unknown): { value: T } | { issues: Array<{ message: string }> };
  } = {
    version: 1,
    vendor: 'kodex-chat',
    validate(value: unknown) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { issues: [{ message: 'Expected an input object.' }] };
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !keys.includes(key))) return { issues: [{ message: 'Unexpected input field.' }] };
      for (const key of keys) {
        const field = input[key];
        const maximumLength = key === 'text' ? 100_000 : 256;
        if (typeof field !== 'string' || !field.trim() || field.length > maximumLength) return { issues: [{ message: `Invalid ${String(key)}.` }] };
      }
      return { value: value as T };
    },
  };
  return { '~standard': standard };
}
const chatInput = objectInput<{ chatId: string }>(['chatId']);
const messageInput = objectInput<{ chatId: string; text: string }>(['chatId', 'text']);

export function createChatRouter(service: ChatService) {
  return {
    info: os.handler(() => service.info()),
    listChats: os.handler(() => service.listChats()),
    createChat: os.input(objectInput<{ projectId: string }>(['projectId'])).handler(({ input }) => service.createChat(input)),
    openChat: os.input(chatInput).handler(({ input, signal }) => service.openChat(input, signal)),
    watchChat: os.input(chatInput).output(eventIterator(schemaType<ChatSnapshot>())).handler(({ input, signal }) => service.watchChat(input, signal)),
    watchCatalog: os.output(eventIterator(schemaType<CatalogSnapshot>())).handler(({ signal }) => service.watchCatalog(signal)),
    send: os.input(messageInput).handler(({ input }) => service.send(input)),
    queue: os.input(messageInput).handler(({ input }) => service.queue(input)),
    stop: os.input(chatInput).handler(({ input }) => service.stop(input)),
  };
}
export type ChatRouter = ReturnType<typeof createChatRouter>;
