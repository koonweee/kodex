import { nativeSettingsFixture } from './testBuilders';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { NativeComposer } from './NativeComposer';
import type { ChatSnapshot } from './client';
import type { WorkspacePane } from '../workspace/paneTypes';
import { baseRoutes, mockGateway } from '../test/mvpAppHarness';

const rpc = vi.hoisted(() => ({ listModels: vi.fn(), watchDraftDefaults: vi.fn(), updateChatSettings: vi.fn(), createChat: vi.fn(), send: vi.fn(), queue: vi.fn(), stop: vi.fn() }));
const workspace = vi.hoisted(() => ({ updatePane: vi.fn().mockResolvedValue(undefined), setPaneDraftDisposable: vi.fn(), onImageOpen: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ projects: [{ id: 'project', name: 'Project', path: '/project' }, { id: 'other', name: 'Other', path: '/other' }] }) }));
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => workspace }));
const onError = vi.fn();
const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const models = [{ id: 'openai-codex/gpt-5.4', provider: 'openai-codex', modelName: 'gpt-5.4', hasApiKey: true, useCount: 0, thinkingLevels: [...levels] }, { id: 'openai-codex/gpt-5.5', provider: 'openai-codex', modelName: 'gpt-5.5', hasApiKey: true, useCount: 0, thinkingLevels: [...levels] }];
function snapshot(modelId = models[0].id, thinkingLevel: 'high' | 'medium' | 'max' = 'medium'): ChatSnapshot {
  return { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: 'project', cwd: '/project', title: 'Chat' }, error: null, messages: [], display: defaultDisplayState(), settings: nativeSettingsFixture(modelId, thinkingLevel) };
}
function defaultsStream() {
  let consumer: ((value: IteratorResult<unknown>) => void) | undefined;
  return { publish(value: unknown) { if (!consumer) throw new Error('No defaults consumer'); consumer({ value, done: false }); consumer = undefined; }, iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<unknown>>(resolve => { consumer = resolve; }) }; } } };
}
function defaults(modelId = models[0].id, thinkingLevel = 'medium') { return { epoch: 'epoch', revision: 1, version: 'version', modelId, thinkingLevel, thinkingLevels: [...levels] }; }
function renderComposer(pane: WorkspacePane, initial: ChatSnapshot | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const draftStore = new Map();
  let currentPane = pane;
  const element = (value: ChatSnapshot | null) => <QueryClientProvider client={client}><MantineProvider env="test"><NativeComposer pane={currentPane} snapshot={value} ready isActive draftStore={draftStore} onError={onError} /></MantineProvider></QueryClientProvider>;
  const view = render(element(initial));
  return { ...view, rerenderSnapshot(value: ChatSnapshot) { view.rerender(element(value)); }, rerenderPane(value: WorkspacePane) { currentPane = value; view.rerender(element(null)); } };
}
async function pick(trigger: RegExp, submenu: 'Model' | 'Reasoning', item: string) {
  await userEvent.click(await screen.findByRole('button', { name: trigger }));
  await userEvent.click(await screen.findByRole('menuitem', { name: submenu }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  const button = screen.getByRole('button', { name: /^Model:/ });
  if (!button.hasAttribute('disabled')) await waitFor(() => expect(button).toHaveFocus());
}
function setup() {
  mockGateway(baseRoutes());
  rpc.listModels.mockResolvedValue(models);
  rpc.send.mockResolvedValue({ accepted: true });
  rpc.createChat.mockResolvedValue({ id: 'created' });
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
it('uses native controls and sparse edits while a late acknowledgment cannot overwrite canonical settings', async () => {
  setup();
  let acknowledge!: (value: unknown) => void;
  rpc.updateChatSettings.mockReturnValue(new Promise(resolve => { acknowledge = resolve; }));
  const view = renderComposer({ id: 'pane', kind: 'thread', target: { mode: 'existing', threadId: 'chat' } }, snapshot());
  await pick(/Model: gpt-5.4, medium/, 'Reasoning', 'High');
  expect(rpc.updateChatSettings).toHaveBeenCalledWith({ chatId: 'chat', patch: { thinkingLevel: 'high' } });
  view.rerenderSnapshot({ ...snapshot(models[1].id, 'max'), revision: 3 });
  await act(async () => acknowledge({ modelId: models[0].id, thinkingLevel: 'high', thinkingLevels: [...levels] }));
  expect(await screen.findByRole('button', { name: 'Model: gpt-5.5, max' })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Message composer'), 'Existing text');
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(rpc.send).toHaveBeenCalledWith({ chatId: 'chat', text: 'Existing text' }));
  expect(rpc.createChat).not.toHaveBeenCalled();
});
it('keeps explicit draft choices local through defaults updates and passes them only at creation', async () => {
  setup();
  const stream = defaultsStream(); rpc.watchDraftDefaults.mockResolvedValue(stream.iterable);
  renderComposer({ id: 'draft', kind: 'thread', target: { mode: 'draft', projectId: 'project' } }, null);
  await waitFor(() => expect(rpc.watchDraftDefaults).toHaveBeenCalled());
  await act(async () => stream.publish(defaults()));
  await pick(/Model: gpt-5.4, medium/, 'Model', 'gpt-5.5');
  await pick(/Model: gpt-5.5/, 'Reasoning', 'Max');
  await userEvent.type(screen.getByLabelText('Message composer'), 'Draft text');
  await act(async () => stream.publish({ ...defaults(models[0].id, 'low'), revision: 2 }));
  expect(screen.getByRole('button', { name: 'Model: gpt-5.5, max' })).toBeInTheDocument();
  expect(screen.getByLabelText('Message composer')).toHaveValue('Draft text');
  expect(rpc.updateChatSettings).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(rpc.createChat).toHaveBeenCalledWith({ projectId: 'project', settings: { modelId: models[1].id, thinkingLevel: 'max', fast: false } }));
  expect(rpc.send).toHaveBeenCalledWith({ chatId: 'created', text: 'Draft text' });
});
it('updates Fast sparsely and waits for canonical settings before displaying it', async () => {
  setup();
  let acknowledge!: (value: unknown) => void;
  rpc.updateChatSettings.mockReturnValue(new Promise(resolve => { acknowledge = resolve; }));
  const view = renderComposer({ id: 'pane', kind: 'thread', target: { mode: 'existing', threadId: 'chat' } }, snapshot());
  await userEvent.click(await screen.findByRole('button', { name: 'Model: gpt-5.4, medium' }));
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Fast' }));
  await waitFor(() => expect(rpc.updateChatSettings).toHaveBeenCalledWith({ chatId: 'chat', patch: { fast: true } }));
  expect(screen.queryByRole('img', { name: 'Fast responses enabled' })).not.toBeInTheDocument();
  const canonical = snapshot();
  view.rerenderSnapshot({ ...canonical, revision: 2, settings: { ...canonical.settings, fast: true } });
  expect(await screen.findByRole('img', { name: 'Fast responses enabled' })).toBeInTheDocument();
  view.rerenderSnapshot({ ...canonical, revision: 3 });
  await act(async () => acknowledge({ fast: true }));
  expect(screen.queryByRole('img', { name: 'Fast responses enabled' })).not.toBeInTheDocument();
});

it('clears an incompatible draft override according to the supplied model capability list', async () => {
  setup();
  rpc.listModels.mockResolvedValue([models[0], { ...models[1], thinkingLevels: ['off'] }]);
  const stream = defaultsStream(); rpc.watchDraftDefaults.mockResolvedValue(stream.iterable);
  renderComposer({ id: 'draft', kind: 'thread', target: { mode: 'draft', projectId: 'project' } }, null);
  await waitFor(() => expect(rpc.watchDraftDefaults).toHaveBeenCalled());
  await act(async () => stream.publish(defaults()));
  await pick(/Model: gpt-5.4, medium/, 'Model', 'gpt-5.5');
  expect(screen.getByRole('button', { name: 'Model: gpt-5.5' })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Message composer'), 'Use native default');
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(rpc.createChat).toHaveBeenCalledWith({ projectId: 'project', settings: { modelId: models[1].id, thinkingLevel: null, fast: false } }));
});

it('scopes edited draft choices to the project and restores them when returning', async () => {
  setup();
  const stream = defaultsStream(); rpc.watchDraftDefaults.mockResolvedValue(stream.iterable);
  const pane: WorkspacePane = { id: 'draft', kind: 'thread', target: { mode: 'draft', projectId: 'project' } };
  const view = renderComposer(pane, null);
  await waitFor(() => expect(rpc.watchDraftDefaults).toHaveBeenCalled());
  await act(async () => stream.publish(defaults()));
  await pick(/Model: gpt-5.4, medium/, 'Model', 'gpt-5.5');
  await pick(/Model: gpt-5.5/, 'Reasoning', 'Max');
  view.rerenderPane({ ...pane, target: { mode: 'draft', projectId: 'other' } });
  expect(await screen.findByRole('button', { name: 'Model: gpt-5.4, medium' })).toBeInTheDocument();
  view.rerenderPane(pane);
  expect(await screen.findByRole('button', { name: 'Model: gpt-5.5, max' })).toBeInTheDocument();
});
it('freezes the displayed model after an explicit draft effort change, matching main', async () => {
  setup();
  const stream = defaultsStream(); rpc.watchDraftDefaults.mockResolvedValue(stream.iterable);
  renderComposer({ id: 'draft', kind: 'thread', target: { mode: 'draft', projectId: 'project' } }, null);
  await waitFor(() => expect(rpc.watchDraftDefaults).toHaveBeenCalled());
  await act(async () => stream.publish(defaults()));
  await pick(/Model: gpt-5.4, medium/, 'Reasoning', 'High');
  await act(async () => stream.publish({ ...defaults(models[1].id, 'low'), revision: 2 }));
  expect(screen.getByRole('button', { name: 'Model: gpt-5.4, high' })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Message composer'), 'Keep these choices');
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(rpc.createChat).toHaveBeenCalledWith({ projectId: 'project', settings: { modelId: models[0].id, thinkingLevel: 'high', fast: false } }));
});

it('submits only the changed existing-chat model and waits for canonical display', async () => {
  setup();
  rpc.updateChatSettings.mockResolvedValue({});
  const view = renderComposer({ id: 'pane', kind: 'thread', target: { mode: 'existing', threadId: 'chat' } }, snapshot());
  await pick(/Model: gpt-5.4, medium/, 'Model', 'gpt-5.5');
  expect(rpc.updateChatSettings).toHaveBeenCalledWith({ chatId: 'chat', patch: { modelId: models[1].id } });
  expect(screen.getByRole('button', { name: 'Model: gpt-5.4, medium' })).toBeInTheDocument();
  view.rerenderSnapshot({ ...snapshot(models[1].id), revision: 2 });
  expect(screen.getByRole('button', { name: 'Model: gpt-5.5, medium' })).toBeInTheDocument();
});

it('offers only models whose native provider authentication is available', async () => {
  setup();
  rpc.listModels.mockResolvedValue([models[0], { ...models[1], hasApiKey: false }]);
  renderComposer({ id: 'pane', kind: 'thread', target: { mode: 'existing', threadId: 'chat' } }, snapshot());
  await userEvent.click(await screen.findByRole('button', { name: 'Model: gpt-5.4, medium' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Model' }));
  expect(screen.getByRole('menuitem', { name: 'gpt-5.4' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'gpt-5.5' })).not.toBeInTheDocument();
});


it('retains draft Fast across model, reasoning and defaults changes and sends it only at creation', async () => {
  setup();
  const stream = defaultsStream(); rpc.watchDraftDefaults.mockResolvedValue(stream.iterable);
  renderComposer({ id: 'draft', kind: 'thread', target: { mode: 'draft', projectId: 'project' } }, null);
  await waitFor(() => expect(rpc.watchDraftDefaults).toHaveBeenCalled());
  await act(async () => stream.publish(defaults()));
  await userEvent.click(await screen.findByRole('button', { name: 'Model: gpt-5.4, medium' }));
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Fast' }));
  expect(await screen.findByRole('img', { name: 'Fast responses enabled' })).toBeInTheDocument();
  await pick(/Model: gpt-5.4, medium/, 'Model', 'gpt-5.5');
  await pick(/Model: gpt-5.5/, 'Reasoning', 'Max');
  await act(async () => stream.publish({ ...defaults(models[0].id, 'low'), revision: 2 }));
  expect(screen.getByRole('button', { name: 'Model: gpt-5.5, max' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Fast responses enabled' })).toBeInTheDocument();
  expect(rpc.updateChatSettings).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText('Message composer'), 'Use draft Fast');
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(rpc.createChat).toHaveBeenCalledWith({ projectId: 'project', settings: { modelId: models[1].id, thinkingLevel: 'max', fast: true } }));
  expect(rpc.send).toHaveBeenCalledWith({ chatId: 'created', text: 'Use draft Fast' });
});

it('shows a native Fast rejection without changing canonical settings or replaying defaults with Send', async () => {
  setup();
  const otherModel = { ...models[0], id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', modelName: 'claude-sonnet-4-5' };
  rpc.listModels.mockResolvedValue([otherModel]);
  const failure = new Error('Fast responses are not supported by this native model. Turn Fast off before choosing another provider.');
  rpc.updateChatSettings.mockRejectedValue(failure);
  renderComposer({ id: 'pane', kind: 'thread', target: { mode: 'existing', threadId: 'chat' } }, snapshot(otherModel.id));
  await userEvent.click(await screen.findByRole('button', { name: 'Model: claude-sonnet-4-5, medium' }));
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Fast' }));
  await waitFor(() => expect(rpc.updateChatSettings).toHaveBeenCalledWith({ chatId: 'chat', patch: { fast: true } }));
  await waitFor(() => expect(screen.getByRole('alert', { name: 'Chat settings error' })).toHaveTextContent(failure.message));
  expect(onError).toHaveBeenCalledWith(failure);
  expect(screen.queryByRole('img', { name: 'Fast responses enabled' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Model: claude-sonnet-4-5, medium' })).toBeEnabled();
  await userEvent.type(screen.getByLabelText('Message composer'), 'Use normal responses');
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(rpc.send).toHaveBeenCalledWith({ chatId: 'chat', text: 'Use normal responses' }));
  expect(rpc.createChat).not.toHaveBeenCalled();
});
