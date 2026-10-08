import { nativeComposerInput } from './nativeComposerInput';
import { Alert } from '@mantine/core';
import { ORPCError } from '@orpc/client';
import { useEffect, useRef } from 'react';
import { ComposerPanel } from '../composer/ComposerPanel';
import { useComposerOrchestration } from '../composer/useComposerOrchestration';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import { paneTargetRecord, type WorkspacePane } from '../workspace/paneTypes';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { mastraClient, mastraUploadClient, type ChatSnapshot } from './client';
import { useNativeCatalogSnapshot } from './NativeCatalogContext';
import { DEFAULT_COMPOSER_SETTINGS } from '../composer/settings';
import { useNativeComposerSettings } from './useNativeComposerSettings';
import { useMastraQueue } from './useMastraQueue';
import { useMastraGoal } from './useMastraGoal';
import { useNativeSkills } from './useNativeSkills';

export function NativeComposer({ pane, snapshot, ready, isActive, draftStore, onError, onQueueReload }: { pane: WorkspacePane; snapshot: ChatSnapshot | null; ready: boolean; isActive: boolean; draftStore: ComposerDraftStore; onError: (error: unknown) => void; onQueueReload?: () => void }) {
  const catalog = useNativeCatalogSnapshot();
  const projects = catalog?.projects ?? [];
  const { updatePane, setPaneDraftDisposable, onImageOpen } = useWorkspace();
  const target = paneTargetRecord(pane);
  const chatId = target.mode === 'existing' && typeof target.threadId === 'string' ? target.threadId : null;
  const projectId = chatId ? snapshot?.chat.projectId ?? null : typeof target.projectId === 'string' ? target.projectId : null;
  const project = projects.find(value => value.id === projectId);
  const created = useRef<string | null>(null);
  const createdProject = useRef(projectId);
  useEffect(() => { if (createdProject.current !== projectId) { created.current = null; createdProject.current = projectId; } }, [projectId]);
  const validDraftProject = projectId === null || project?.roots.length === 1;
  const canCompose = chatId ? ready : Boolean(catalog) && validDraftProject;
  const composerCwd = snapshot?.chat.cwd ?? (project?.roots.length === 1 ? project.roots[0] : undefined);
  const skillCatalog = useNativeSkills({ chatId, projectId, epoch: chatId ? snapshot?.epoch : catalog?.epoch, cwd: composerCwd, enabled: canCompose });
  const settings = useNativeComposerSettings({ chatId, projectId, snapshot, onError,
    modelsEnabled: Boolean(chatId) || Boolean(catalog) && validDraftProject,
    modelScope: chatId ? undefined : JSON.stringify([catalog?.epoch, project?.roots ?? null]),
  });
  const goal = useMastraGoal(chatId, snapshot, ready, onQueueReload);
  const queue = useMastraQueue(chatId, snapshot?.queue ?? null, onError, onQueueReload);
  const submitNative = async (action: () => Promise<unknown>) => {
    try { return await action(); } catch (failure) {
      if (failure instanceof ORPCError && ['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND', 'UNAUTHORIZED', 'FORBIDDEN', 'UNPROCESSABLE_CONTENT', 'TOO_MANY_REQUESTS', 'PRECONDITION_FAILED'].includes(failure.code)) throw failure;
      throw new Error("Delivery could not be confirmed; check the conversation/queue before sending again.", { cause: failure });
    }
  };
  const orchestration = useComposerOrchestration({
    activeSelectedTurnId: null, isRunning: snapshot?.display.isRunning ?? false,
    canCompose, composerSettings: settings.settings ?? DEFAULT_COMPOSER_SETTINGS,
    draftChatThreadSelected: !chatId, draftThreadProjectId: projectId, isDraftThreadSelected: !chatId,
    selectedProjectId: projectId, selectedThreadId: chatId,
    onCreateDraftThread: async () => {
      if (!validDraftProject) throw new Error('Choose one root directory in project settings before starting a chat.');
      if (!created.current) created.current = (await mastraClient.createChat({ projectId, ...(settings.creationSettings ? { settings: settings.creationSettings } : {}) })).id;
      return { threadId: created.current };
    },
    onThreadMaterialized: id => { void updatePane(pane.id, { target: { mode: 'existing', threadId: id } }).catch(onError); },
    onThreadTurnStarted: () => {}, onThreadTurnStartFailed: () => {}, onError,
    commands: {
      send: async (id, input, attachments, images, mentions) => {
        const value = nativeComposerInput(input, attachments, images, mentions);
        return submitNative(() => mastraClient.send({ chatId: id, queueIfPending: true, ...value }));
      },
      queue: async (id, input, attachments, images, mentions) => {
        const value = nativeComposerInput(input, attachments, images, mentions);
        return submitNative(() => mastraClient.queue({ chatId: id, ...value }));
      },
      uploads: {
        images: (chatId, files) => Promise.all(files.map(file => mastraUploadClient.uploadImage({ chatId, file }))),
        files: (chatId, files) => Promise.all(files.map(file => mastraUploadClient.uploadFile({ chatId, file }))),
      },
      stop: id => mastraClient.stop({ chatId: id }),
      compact: async () => {
        throw new Error("Mastra manages conversation memory automatically. Manual /compact is not supported; no compaction was requested.");
      },
    },
  });
  return <>
    {!chatId && projectId && catalog && !validDraftProject ? <Alert color="red" title="Project unavailable" mx="md" mt="xs">Choose one root directory in project settings before starting a chat.</Alert> : null}
    {settings.error ? <Alert color="red" title="Chat settings error" mx="md" mt="xs">{settings.error}</Alert> : null}
    <ComposerPanel activeSelectedTurnId={null} isRunning={snapshot?.display.isRunning ?? false}
      attachmentInputRef={orchestration.attachmentInputRef} canCompose={canCompose}
      composerSettings={settings.settings} composerSettingsDisabled={settings.pending} composerSettingsError={settings.error} composerResetToken={0}
      composerDraftKey={`pane:${pane.id}:${chatId ?? 'draft'}`} composerDraftStore={draftStore}
      onDraftDisposableChange={disposable => { if (!chatId) setPaneDraftDisposable(pane.id, disposable && !created.current); }}
      composerCwd={composerCwd} currentProjectName={project?.name} skillCatalog={skillCatalog}
      draftProjectSelector={!chatId ? { value: projectId, projects, onChange: id => { void updatePane(pane.id, { target: { mode: 'draft', projectId: id } }).catch(onError); } } : undefined}
      isDraftThreadSelected={!chatId} isDraftComposerTransitioning={false} isComposerDragActive={orchestration.isComposerDragActive}
      isComposerSubmitting={orchestration.isComposerSubmitting} isSelectedTimelineReady={ready} models={settings.models}
      onAttachmentInputChange={orchestration.handleAttachmentInputChange} onComposerDragLeave={orchestration.handleComposerDragLeave}
      onComposerDragOver={orchestration.handleComposerDragOver} onComposerDrop={orchestration.handleComposerDrop}
      onComposerKeyDown={orchestration.handleComposerKeyDown} onComposerPaste={orchestration.handleComposerPaste}
      onComposerSettingsChange={settings.change} onImageOpen={onImageOpen} onRemovePendingAttachment={orchestration.removePendingAttachment}
      onStopTurn={orchestration.handleStopTurn} onSubmitTurn={orchestration.handleSubmitTurn} pendingAttachments={orchestration.pendingAttachments}
      goalThreadId={chatId} goalController={goal} queueThreadId={chatId} queueController={queue} queueDialogActive={isActive} selectedThreadPresent={Boolean(chatId)} />
  </>;
}
