import { validChatInput, type ChatInput } from './chat-input.js';
import type { ChatPromptResponse } from './chat-service.js';
import { eventIterator, os, type as schemaType } from '@orpc/server';
import type { HistoryRequest } from './chat-history.js';
import type { SubagentList, SubagentSelection, SubagentSnapshot } from './chat-subagents.js';
import type { GoalPatch } from './chat-goals.js';
import type { ProjectPatch } from './product-registry.js';
import type { AccountSnapshot } from './account-service.js';
import type { CatalogSnapshot, ChatService, ChatSnapshot, QueuedSelection, QueuedEdit, QueuedOrder } from './chat-service.js';
import { validSettingsPatch, type ChatSettingsPatch, type DraftDefaults } from './chat-settings.js';

import { inputSchema } from './rpc-input.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown, maximumLength = 256) => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximumLength;
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
function objectInput<T extends Record<string, string>>(keys: (keyof T & string)[]) {
  return inputSchema<T>(value => object(value) && only(value, keys) && keys.every(key => string(value[key], key === 'text' ? 100_000 : 256)));
}
const chatInput = objectInput<{ chatId: string }>(['chatId']);
const uploadInput = inputSchema<{ chatId: string; file: File }>(value => object(value) && only(value, ['chatId', 'file']) && string(value.chatId) && value.file instanceof File);
const pinInput = inputSchema<{ chatId: string; pinned: boolean; beforeChatId?: string | null }>(value => object(value) && only(value, ['chatId', 'pinned', 'beforeChatId']) && string(value.chatId) && typeof value.pinned === 'boolean' && (!('beforeChatId' in value) || value.pinned && (value.beforeChatId === null || string(value.beforeChatId))));
const notificationsInput = inputSchema<{ chatId: string; enabled: boolean }>(value => object(value) && only(value, ['chatId', 'enabled']) && string(value.chatId) && typeof value.enabled === 'boolean');
const renameInput = objectInput<{ chatId: string; title: string }>(['chatId', 'title']);
const promptResponseInput = inputSchema<ChatPromptResponse>(value => {
  if (!object(value) || !string(value.chatId) || !object(value.target)
    || !only(value.target, ['sessionId', 'threadId', 'resourceId', 'runId', 'toolCallId'])
    ) return false;
  const target = value.target;
  if (!['sessionId', 'threadId', 'resourceId', 'runId', 'toolCallId'].every(key => string(target[key], 4096))) return false;
  if (value.kind === 'question') return only(value, ['chatId', 'target', 'kind', 'answer'])
    && (string(value.answer, 100_000) || Array.isArray(value.answer) && value.answer.length > 0 && value.answer.every(answer => string(answer, 100_000)));
  if (value.kind === 'approval') return only(value, ['chatId', 'target', 'kind', 'decision'])
    && ['approve', 'decline', 'always_allow_category'].includes(value.decision as string);
  return value.kind === 'plan' && only(value, ['chatId', 'target', 'kind', 'action', 'feedback', 'previewVersion'])
    && (value.action === 'approved' || value.action === 'rejected') && (value.previewVersion === undefined || string(value.previewVersion, 128)) && (value.feedback === undefined || typeof value.feedback === 'string' && value.feedback.length <= 100_000);
});
const questionReplyInput = inputSchema<{ chatId: string; text: string; clientId: string }>(value => object(value) && only(value, ['chatId', 'text', 'clientId']) && string(value.chatId) && string(value.text, 100_000) && string(value.clientId, 4096));
const messageInput = inputSchema<ChatInput & { chatId: string }>(value => object(value) && only(value, ['chatId', 'text', 'images', 'files', 'skills', 'skillMentions']) && string(value.chatId) && validChatInput(value));
const sendInput = inputSchema<ChatInput & { chatId: string; queueIfPending?: boolean }>(value => object(value) && only(value, ['chatId', 'text', 'images', 'files', 'skills', 'skillMentions', 'queueIfPending']) && string(value.chatId) && validChatInput(value) && (!('queueIfPending' in value) || typeof value.queueIfPending === 'boolean'));
const queueVersion = (value: Record<string, unknown>) => string(value.chatId) && string(value.epoch) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
const queuedInput = inputSchema<QueuedSelection>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'id']) && queueVersion(value) && string(value.id));
const queuedEdit = inputSchema<QueuedEdit>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'id', 'input']) && queueVersion(value) && string(value.id) && object(value.input) && only(value.input, ['text']) && typeof value.input.text === 'string' && value.input.text.length <= 100_000);
const queuedOrder = inputSchema<QueuedOrder>(value => object(value) && only(value, ['chatId', 'epoch', 'revision', 'ids']) && queueVersion(value) && Array.isArray(value.ids) && value.ids.every(id => string(id)));
const createInput = inputSchema<{ projectId?: string | null; settings?: ChatSettingsPatch }>(value => object(value) && only(value, ['projectId', 'settings']) && (!('projectId' in value) || value.projectId === null || string(value.projectId)) && (!('settings' in value) || validSettingsPatch(value.settings)));
const modelsInput = inputSchema<{ chatId?: string; projectId?: string | null }>(value => object(value) && only(value, ['chatId', 'projectId']) && ('chatId' in value ? !('projectId' in value) && string(value.chatId) : !('projectId' in value) || value.projectId === null || string(value.projectId)));
const directoryInput = inputSchema<{ path?: string }>(value => object(value) && only(value, ['path']) && (!('path' in value) || string(value.path, 4096)));
const projectCreateInput = inputSchema<{ createKey: string; path: string }>(value => object(value) && only(value, ['createKey', 'path']) && string(value.createKey) && string(value.path, 4096));
const projectPatch = (value: unknown) => object(value) && only(value, ['name', 'roots']) && (!('name' in value) || string(value.name)) && (!('roots' in value) || Array.isArray(value.roots) && value.roots.every(path => string(path, 4096)));
const projectUpdateInput = inputSchema<{ projectId: string; patch: ProjectPatch }>(value => object(value) && only(value, ['projectId', 'patch']) && string(value.projectId) && projectPatch(value.patch));
const projectMoveInput = inputSchema<{ projectId: string; beforeId: string | null }>(value => object(value) && only(value, ['projectId', 'beforeId']) && string(value.projectId) && (value.beforeId === null || string(value.beforeId)));
const chatSettingsInput = inputSchema<{ chatId: string; patch: ChatSettingsPatch }>(value => object(value) && only(value, ['chatId', 'patch']) && string(value.chatId) && validSettingsPatch(value.patch));
const goalInput = inputSchema<{ chatId: string; patch: GoalPatch }>(value => object(value) && only(value, ['chatId', 'patch']) && string(value.chatId) && object(value.patch) && only(value.patch, ['objective', 'status']) && Object.keys(value.patch).length > 0 && (!('objective' in value.patch) || string(value.patch.objective, 100_000)) && (!('status' in value.patch) || value.patch.status === 'active' || value.patch.status === 'paused'));
const defaultsInput = inputSchema<{ version: string; patch: ChatSettingsPatch }>(value => object(value) && only(value, ['version', 'patch']) && string(value.version) && validSettingsPatch(value.patch, false));

const validHistory = (value: unknown) => value === undefined || (object(value) && only(value, ['earliest', 'older']) && (value.earliest === undefined || (typeof value.earliest === 'string' && value.earliest.length <= 32 && Number.isFinite(Date.parse(value.earliest)))) && (value.older === undefined || typeof value.older === 'boolean'));
const historyInput = inputSchema<{ chatId: string; history?: HistoryRequest }>(value => object(value) && only(value, ['chatId', 'history']) && string(value.chatId) && validHistory(value.history));
const subagentInput = inputSchema<SubagentSelection>(value => object(value) && only(value, ['chatId', 'kind', 'id', 'history']) && string(value.chatId) && string(value.id) && (value.kind === 'invocation' || value.kind === 'fork' || value.kind === 'child') && validHistory(value.history));

export function createChatRouter(service: ChatService) {
  return {
    info: os.handler(() => service.info()),
    getAccount: os.handler(() => service.getAccount()),
    logoutAccount: os.handler(() => service.logoutAccount()),
    getAccountUsage: os.handler(({ signal }) => service.getAccountUsage(signal)),
    watchAccount: os.output(eventIterator(schemaType<AccountSnapshot>())).handler(({ signal }) => service.watchAccount(signal)),
    listChats: os.handler(() => service.listChats()),
    readChatRoute: os.input(chatInput).handler(({ input }) => service.readChatRoute(input)),
    listSubagents: os.input(historyInput).handler(({ input, signal }) => service.listSubagents(input, signal)),
    watchSubagents: os.input(historyInput).output(eventIterator(schemaType<SubagentList>())).handler(({ input, signal }) => service.watchSubagents(input, signal)),
    openSubagent: os.input(subagentInput).handler(({ input, signal }) => service.openSubagent(input, signal)),
    watchSubagent: os.input(subagentInput).output(eventIterator(schemaType<SubagentSnapshot>())).handler(({ input, signal }) => service.watchSubagent(input, signal)),
    listSkills: os.input(modelsInput).handler(({ input }) => service.listSkills(input)),
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
    updateGoal: os.input(goalInput).handler(({ input }) => service.updateGoal(input)),
    clearGoal: os.input(chatInput).handler(({ input }) => service.clearGoal(input)),
    getChatSettings: os.input(chatInput).handler(({ input }) => service.getChatSettings(input)),
    updateChatSettings: os.input(chatSettingsInput).handler(({ input }) => service.updateChatSettings(input)),
    getDraftDefaults: os.handler(() => service.getDraftDefaults()),
    updateDraftDefaults: os.input(defaultsInput).handler(({ input }) => service.updateDraftDefaults(input)),
    watchDraftDefaults: os.output(eventIterator(schemaType<DraftDefaults>())).handler(({ signal }) => service.watchDraftDefaults(signal)),
    createChat: os.input(createInput).handler(({ input }) => service.createChat(input)),
    openChat: os.input(historyInput).handler(({ input, signal }) => service.openChat(input, signal)),
    watchChat: os.input(historyInput).output(eventIterator(schemaType<ChatSnapshot>())).handler(({ input, signal }) => service.watchChat(input, signal)),
    watchCatalog: os.output(eventIterator(schemaType<CatalogSnapshot>())).handler(({ signal }) => service.watchCatalog(signal)),
    respondPrompt: os.input(promptResponseInput).handler(({ input }) => service.respondPrompt(input)),
    replyToQuestion: os.input(questionReplyInput).handler(({ input }) => service.replyToQuestion(input)),
    uploadImage: os.input(uploadInput).handler(({ input }) => service.uploadImage(input)),
    uploadFile: os.input(uploadInput).handler(({ input }) => service.uploadFile(input)),
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
