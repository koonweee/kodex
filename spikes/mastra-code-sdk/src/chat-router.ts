import { eventIterator, os, type as schemaType } from '@orpc/server';
import type { AccountSnapshot } from './account-service.js';
import type { CatalogSnapshot, ChatService, ChatSnapshot, QueuedSelection, QueuedEdit, QueuedOrder } from './chat-service.js';
import { validSettingsPatch, type ChatSettingsPatch, type DraftDefaults } from './chat-settings.js';

/** Actual Standard Schema validation, including nested sparse settings patches. */
function inputSchema<T>(valid: (value: unknown) => boolean) {
  const standard: {
    version: 1; vendor: string; types?: { input: T; output: T };
    validate(value: unknown): { value: T } | { issues: Array<{ message: string }> };
  } = {
    version: 1, vendor: 'kodex-chat',
    validate(value) { return valid(value) ? { value: value as T } : { issues: [{ message: 'Invalid input fields.' }] }; },
  };
  return { '~standard': standard };
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown, maximumLength = 256) => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximumLength;
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
function objectInput<T extends Record<string, string>>(keys: (keyof T & string)[]) {
  return inputSchema<T>(value => object(value) && only(value, keys) && keys.every(key => string(value[key], key === 'text' ? 100_000 : 256)));
}
const chatInput = objectInput<{ chatId: string }>(['chatId']);
const messageInput = objectInput<{ chatId: string; text: string }>(['chatId', 'text']);
const sendInput = inputSchema<{ chatId: string; text: string; queueIfPending?: boolean }>(value => object(value) && only(value, ['chatId', 'text', 'queueIfPending']) && string(value.chatId) && string(value.text, 100_000) && (!('queueIfPending' in value) || typeof value.queueIfPending === 'boolean'));
const queueVersion = (value: Record<string, unknown>) => string(value.chatId) && string(value.epoch) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
const queuedInput = inputSchema<QueuedSelection>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'id']) && queueVersion(value) && string(value.id));
const queuedEdit = inputSchema<QueuedEdit>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'id', 'input']) && queueVersion(value) && string(value.id) && object(value.input) && only(value.input, ['text']) && string(value.input.text, 100_000));
const queuedOrder = inputSchema<QueuedOrder>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'ids']) && queueVersion(value) && Array.isArray(value.ids) && value.ids.every(id => string(id)));
const createInput = inputSchema<{ projectId: string; settings?: ChatSettingsPatch }>(value => object(value) && only(value, ['projectId', 'settings']) && string(value.projectId) && (!('settings' in value) || validSettingsPatch(value.settings)));
const chatSettingsInput = inputSchema<{ chatId: string; patch: ChatSettingsPatch }>(value => object(value) && only(value, ['chatId', 'patch']) && string(value.chatId) && validSettingsPatch(value.patch));
const defaultsInput = inputSchema<{ version: string; patch: ChatSettingsPatch }>(value => object(value) && only(value, ['version', 'patch']) && string(value.version) && validSettingsPatch(value.patch, false));

export function createChatRouter(service: ChatService) {
  return {
    info: os.handler(() => service.info()),
    getAccount: os.handler(() => service.getAccount()),
    logoutAccount: os.handler(() => service.logoutAccount()),
    getAccountUsage: os.handler(({ signal }) => service.getAccountUsage(signal)),
    watchAccount: os.output(eventIterator(schemaType<AccountSnapshot>())).handler(({ signal }) => service.watchAccount(signal)),
    listChats: os.handler(() => service.listChats()),
    listModels: os.input(objectInput<{ projectId: string }>(['projectId'])).handler(({ input }) => service.listModels(input)),
    getChatSettings: os.input(chatInput).handler(({ input }) => service.getChatSettings(input)),
    updateChatSettings: os.input(chatSettingsInput).handler(({ input }) => service.updateChatSettings(input)),
    getDraftDefaults: os.handler(() => service.getDraftDefaults()),
    updateDraftDefaults: os.input(defaultsInput).handler(({ input }) => service.updateDraftDefaults(input)),
    watchDraftDefaults: os.output(eventIterator(schemaType<DraftDefaults>())).handler(({ signal }) => service.watchDraftDefaults(signal)),
    createChat: os.input(createInput).handler(({ input }) => service.createChat(input)),
    openChat: os.input(chatInput).handler(({ input, signal }) => service.openChat(input, signal)),
    watchChat: os.input(chatInput).output(eventIterator(schemaType<ChatSnapshot>())).handler(({ input, signal }) => service.watchChat(input, signal)),
    watchCatalog: os.output(eventIterator(schemaType<CatalogSnapshot>())).handler(({ signal }) => service.watchCatalog(signal)),
    send: os.input(sendInput).handler(({ input }) => service.send(input)),
    queue: os.input(messageInput).handler(({ input }) => service.queue(input)),
    editQueued: os.input(queuedEdit).handler(({ input }) => service.editQueued(input)),
    removeQueued: os.input(queuedInput).handler(({ input }) => service.removeQueued(input)),
    reorderQueued: os.input(queuedOrder).handler(({ input }) => service.reorderQueued(input)),
    steerQueued: os.input(queuedInput).handler(({ input }) => service.steerQueued(input)),
    reconcileQueued: os.input(queuedInput).handler(({ input }) => service.reconcileQueued(input)),
    dismissQueued: os.input(queuedInput).handler(({ input }) => service.dismissQueued(input)),
    stop: os.input(chatInput).handler(({ input }) => service.stop(input)),
  };
}
export type ChatRouter = ReturnType<typeof createChatRouter>;
