import { eventIterator, os, type as schemaType } from '@orpc/server';
import type { ProjectPatch } from './product-registry.js';
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
const pinInput = inputSchema<{ chatId: string; pinned: boolean; beforeChatId?: string | null }>(value => object(value) && only(value, ['chatId', 'pinned', 'beforeChatId']) && string(value.chatId) && typeof value.pinned === 'boolean' && (!('beforeChatId' in value) || value.pinned && (value.beforeChatId === null || string(value.beforeChatId))));
const notificationsInput = inputSchema<{ chatId: string; enabled: boolean }>(value => object(value) && only(value, ['chatId', 'enabled']) && string(value.chatId) && typeof value.enabled === 'boolean');
const renameInput = objectInput<{ chatId: string; title: string }>(['chatId', 'title']);
const messageInput = objectInput<{ chatId: string; text: string }>(['chatId', 'text']);
const sendInput = inputSchema<{ chatId: string; text: string; queueIfPending?: boolean }>(value => object(value) && only(value, ['chatId', 'text', 'queueIfPending']) && string(value.chatId) && string(value.text, 100_000) && (!('queueIfPending' in value) || typeof value.queueIfPending === 'boolean'));
const queueVersion = (value: Record<string, unknown>) => string(value.chatId) && string(value.epoch) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
const queuedInput = inputSchema<QueuedSelection>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'id']) && queueVersion(value) && string(value.id));
const queuedEdit = inputSchema<QueuedEdit>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'id', 'input']) && queueVersion(value) && string(value.id) && object(value.input) && only(value.input, ['text']) && string(value.input.text, 100_000));
const queuedOrder = inputSchema<QueuedOrder>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'ids']) && queueVersion(value) && Array.isArray(value.ids) && value.ids.every(id => string(id)));
const createInput = inputSchema<{ projectId?: string | null; settings?: ChatSettingsPatch }>(value => object(value) && only(value, ['projectId', 'settings']) && (!('projectId' in value) || value.projectId === null || string(value.projectId)) && (!('settings' in value) || validSettingsPatch(value.settings)));
const modelsInput = inputSchema<{ chatId?: string; projectId?: string | null }>(value => object(value) && only(value, ['chatId', 'projectId']) && ('chatId' in value ? !('projectId' in value) && string(value.chatId) : !('projectId' in value) || value.projectId === null || string(value.projectId)));
const directoryInput = inputSchema<{ path?: string }>(value => object(value) && only(value, ['path']) && (!('path' in value) || string(value.path, 4096)));
const projectCreateInput = inputSchema<{ createKey: string; path: string }>(value => object(value) && only(value, ['createKey', 'path']) && string(value.createKey) && string(value.path, 4096));
const projectPatch = (value: unknown) => object(value) && only(value, ['name', 'roots']) && (!('name' in value) || string(value.name)) && (!('roots' in value) || Array.isArray(value.roots) && value.roots.every(path => string(path, 4096)));
const projectUpdateInput = inputSchema<{ projectId: string; patch: ProjectPatch }>(value => object(value) && only(value, ['projectId', 'patch']) && string(value.projectId) && projectPatch(value.patch));
const projectMoveInput = inputSchema<{ projectId: string; beforeId: string | null }>(value => object(value) && only(value, ['projectId', 'beforeId']) && string(value.projectId) && (value.beforeId === null || string(value.beforeId)));
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
    listModels: os.input(modelsInput).handler(({ input }) => service.listModels(input)),
    listDirectories: os.input(directoryInput).handler(({ input }) => service.listDirectories(input)),
    createProject: os.input(projectCreateInput).handler(({ input }) => service.createProject(input)),
    updateProject: os.input(projectUpdateInput).handler(({ input }) => service.updateProject(input)),
    deleteProject: os.input(objectInput<{ projectId: string }>(['projectId'])).handler(({ input }) => service.deleteProject(input)),
    moveProjectBefore: os.input(projectMoveInput).handler(({ input }) => service.moveProjectBefore(input)),
    setChatPinned: os.input(pinInput).handler(({ input }) => service.setChatPinned(input)),
    setChatNotifications: os.input(notificationsInput).handler(({ input }) => service.setChatNotifications(input)),
    archiveChat: os.input(chatInput).handler(({ input }) => service.archiveChat(input)),
    renameChat: os.input(renameInput).handler(({ input }) => service.renameChat(input)),
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
