import { Alert, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ComponentProps } from 'react';
import { ComposerPanel } from '../composer/ComposerPanel';
import { useComposerOrchestration } from '../composer/useComposerOrchestration';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import { createQueuedInput, getComposerSettings, getThreadSettings, listModels, submitThreadInput, getApiBaseUrl, updateThreadSettings } from '../api/client';
import { errorMessageFrom } from '../shared/values';
import { paneTargetRecord, type WorkspacePane } from '../workspace/paneTypes';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { mastraClient, type ChatSnapshot } from './client';
import { useNativeHost } from './NativeHostBoundary';
import { DEFAULT_COMPOSER_SETTINGS } from '../composer/settings';

export function NativeComposer({ pane, snapshot, ready, isActive, draftStore, onError }: { pane: WorkspacePane; snapshot: ChatSnapshot | null; ready: boolean; isActive: boolean; draftStore: ComposerDraftStore; onError: (error: unknown) => void }) {
  const { projects } = useNativeHost();
  const { updatePane, setPaneDraftDisposable, onImageOpen } = useWorkspace();
  const target = paneTargetRecord(pane);
  const chatId = target.mode === 'existing' && typeof target.threadId === 'string' ? target.threadId : null;
  const projectId = chatId ? snapshot?.chat.projectId ?? null : typeof target.projectId === 'string' ? target.projectId : projects[0]?.id ?? null;
  const project = projects.find(value => value.id === projectId);
  const created = useRef<string | null>(null);
  const createdProject = useRef(projectId);
  useEffect(() => { if (createdProject.current !== projectId) { created.current = null; createdProject.current = projectId; } }, [projectId]);
  const models = useQuery({ queryKey: ['mastra-unfinished', 'models'], queryFn: listModels, retry: false });
  const settings = useQuery({ queryKey: ['mastra-unfinished', 'settings', chatId, projectId], queryFn: async ({ signal }) => chatId ? getThreadSettings(chatId, signal) : getComposerSettings(projectId, project?.path, signal), retry: false });
  const orchestration = useComposerOrchestration({
    activeSelectedTurnId: null, isRunning: snapshot?.display.isRunning ?? false,
    canCompose: Boolean(projectId) && (!chatId || ready), composerSettings: DEFAULT_COMPOSER_SETTINGS,
    draftChatThreadSelected: !chatId, draftThreadProjectId: projectId, isDraftThreadSelected: !chatId,
    selectedProjectId: projectId, selectedThreadId: chatId,
    onCreateDraftThread: async () => {
      if (!projectId) throw new Error('Choose a project before starting a chat');
      if (!created.current) created.current = (await mastraClient.createChat({ projectId })).id;
      return { threadId: created.current };
    },
    onThreadMaterialized: id => { void updatePane(pane.id, { target: { mode: 'existing', threadId: id } }).catch(onError); },
    onThreadTurnStarted: () => {}, onThreadTurnStartFailed: () => {}, onError,
    commands: {
      send: async (id, input, attachments) => {
        if (attachments.length || input.some(value => value.type !== 'text')) return submitThreadInput(id, input, attachments);
        return mastraClient.send({ chatId: id, text: input.flatMap(value => value.type === 'text' ? [value.text] : []).join('\n') });
      },
      queue: async (id, input, attachments) => {
        if (attachments.length || input.some(value => value.type !== 'text')) return createQueuedInput(id, input, attachments);
        return mastraClient.queue({ chatId: id, text: input.flatMap(value => value.type === 'text' ? [value.text] : []).join('\n') });
      },
      stop: id => mastraClient.stop({ chatId: id }),
    },
  });
  const settingsError = settings.error ?? models.error;
  const changeSettings: ComponentProps<typeof ComposerPanel>['onComposerSettingsChange'] = change => {
    const operation = chatId ? updateThreadSettings(chatId, change) : fetch(`${getApiBaseUrl()}/v1/composer-settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
    }).then(async response => {
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(body && typeof body === 'object' && 'message' in body ? String(body.message) : `Settings request failed (${response.status})`);
      }
      return response.json();
    });
    void operation.catch(onError);
  };
  return <>
    {settingsError ? <Alert color="red" title="Chat settings error" mx="md" mt="xs">{errorMessageFrom(settingsError)}</Alert> : null}
    {snapshot?.display.queuedFollowUps ? <Text size="sm" mx="md" role="status">{snapshot.display.queuedFollowUps} queued follow-up{snapshot.display.queuedFollowUps === 1 ? '' : 's'}</Text> : null}
    <ComposerPanel activeSelectedTurnId={null} isRunning={snapshot?.display.isRunning ?? false}
      attachmentInputRef={orchestration.attachmentInputRef} canCompose={Boolean(projectId) && (!chatId || ready)}
      composerSettings={null} composerSettingsError={settingsError ? errorMessageFrom(settingsError) : null} composerResetToken={0}
      composerDraftKey={`pane:${pane.id}:${chatId ?? 'draft'}`} composerDraftStore={draftStore}
      onDraftDisposableChange={disposable => { if (!chatId) setPaneDraftDisposable(pane.id, disposable && !created.current); }}
      composerCwd={snapshot?.chat.cwd ?? project?.path} currentProjectName={project?.name}
      draftProjectSelector={!chatId ? { value: projectId, projects, onChange: id => { void updatePane(pane.id, { target: { mode: 'draft', projectId: id } }).catch(onError); } } : undefined}
      isDraftThreadSelected={!chatId} isDraftComposerTransitioning={false} isComposerDragActive={orchestration.isComposerDragActive}
      isComposerSubmitting={orchestration.isComposerSubmitting} isSelectedTimelineReady={ready} models={models.data ?? []}
      onAttachmentInputChange={orchestration.handleAttachmentInputChange} onComposerDragLeave={orchestration.handleComposerDragLeave}
      onComposerDragOver={orchestration.handleComposerDragOver} onComposerDrop={orchestration.handleComposerDrop}
      onComposerKeyDown={orchestration.handleComposerKeyDown} onComposerPaste={orchestration.handleComposerPaste}
      onComposerSettingsChange={changeSettings} onImageOpen={onImageOpen} onRemovePendingAttachment={orchestration.removePendingAttachment}
      onStopTurn={orchestration.handleStopTurn} onSubmitTurn={orchestration.handleSubmitTurn} pendingAttachments={orchestration.pendingAttachments}
      goalThreadId={chatId} queueThreadId={chatId} queueDialogActive={isActive} selectedThreadPresent={Boolean(chatId)} />
  </>;
}
