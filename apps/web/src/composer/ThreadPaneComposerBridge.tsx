import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { Project } from "../api/client";
import { useGatewayClient } from "../api/GatewayClientContext";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings, ComposerSettingsChange, ContextUsage } from "../ComposerFooterControls";
import type { ImageLightboxImage } from "../images/types";
import { singleProjectRoot } from "../projects/roots";
import { useWorkspace, type ThreadComposerState } from "../workspace/WorkspaceProvider";
import { paneTargetRecord, type WorkspacePane } from "../workspace/paneTypes";
import { ComposerPanel } from "./ComposerPanel";
import { applyDraftComposerSettingsChange, contextUsageFromEvent, createThreadOptions, DEFAULT_COMPOSER_SETTINGS, normalizePersistedComposerSettings } from "./settings";
import type { ComposerDraftStore } from "./useComposerDraftState";
import { useComposerOrchestration } from "./useComposerOrchestration";
import type { useComposerSettingsState } from "./useComposerSettingsState";
import { useThreadSettings } from "./useThreadSettings";

type ThreadPaneComposerBridgeProps = {
  composerDefaults: ComposerSettings;
  contextUsageByThreadId: Record<string, ContextUsage>;
  composerDraftStore: ComposerDraftStore;
  hydrateComposerDefaults: (projectId: string | null, cwd?: string | null) => Promise<ComposerSettings | null>;
  isDraftComposerTransitioning: boolean;
  models: ReturnType<typeof useComposerSettingsState>["models"];
  onCreateDraftThread: Parameters<typeof useComposerOrchestration>[0]["onCreateDraftThread"];
  onError: (error: unknown) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onImagePreviewUrlsChanged: (previewUrls: Record<string, string>) => void;
  onThreadMaterialized: (threadId: string) => void;
  onThreadTurnStartFailed: (threadId: string) => void;
  onThreadTurnStarted: (threadId: string) => void;
  pane: WorkspacePane;
  paneState: ThreadComposerState;
  projects: Project[];
  skillsInvalidationGeneration: number;
};

export const ThreadPaneComposerBridge = memo(function ThreadPaneComposerBridge({
  composerDefaults,
  contextUsageByThreadId,
  composerDraftStore,
  hydrateComposerDefaults,
  isDraftComposerTransitioning,
  models,
  onCreateDraftThread,
  onError,
  onImageOpen,
  onImagePreviewUrlsChanged,
  onThreadMaterialized,
  onThreadTurnStartFailed,
  onThreadTurnStarted,
  pane,
  paneState,
  projects,
  skillsInvalidationGeneration,
}: ThreadPaneComposerBridgeProps) {
  const api = useGatewayClient();
  const { defaultExecutorId, publishThreadPaneTimelineAction, setPaneComposerTextDraft, setPaneDraftDisposable, subscribeLiveEvent, updatePane } = useWorkspace();
  const target = paneTargetRecord(pane);
  const existingThreadId = target.mode === "existing" && typeof target.threadId === "string" ? target.threadId : null;
  const isDraftPane = existingThreadId === null;
  const thread = paneState.thread ?? null;
  const isNativeReadOnly = thread?.canAcceptDirectInput === false;
  const inputStateReadable = paneState.isReady && !isNativeReadOnly;
  const threadSettings = useThreadSettings(inputStateReadable ? existingThreadId : null);
  const draftProjectId = target.mode === "draft" && typeof target.projectId === "string" ? target.projectId : null;
  const usesDefaultWorkspaceState = pane.target.executorId === defaultExecutorId;
  const remoteModelsQuery = useQuery({
    enabled: !usesDefaultWorkspaceState,
    queryKey: queryKeys.models,
    queryFn: api.listModels,
  });
  const paneModels = usesDefaultWorkspaceState ? models : remoteModelsQuery.data ?? [];
  const paneComposerDefaults = usesDefaultWorkspaceState ? composerDefaults : DEFAULT_COMPOSER_SETTINGS;
  const remoteProjectsQuery = useQuery({
    enabled: !usesDefaultWorkspaceState,
    queryKey: queryKeys.projects,
    queryFn: () => api.listProjects(),
  });
  const paneProjects = usesDefaultWorkspaceState ? projects : remoteProjectsQuery.data ?? [];
  const currentProject = draftProjectId ? paneProjects.find((project) => project.id === draftProjectId) ?? null : null;
  const composerCwd = isDraftPane ? singleProjectRoot(currentProject) : thread?.cwd ?? null;
  const canCompose = !isNativeReadOnly && (!isDraftPane || draftProjectId === null || (currentProject !== null && composerCwd !== null));
  const [draftComposerEdited, setDraftComposerEdited] = useState(false);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(paneComposerDefaults);
  const [remoteContextUsage, setRemoteContextUsage] = useState<ContextUsage | null>(null);
  const [remoteSkillsInvalidationGeneration, setRemoteSkillsInvalidationGeneration] = useState(0);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const createdDraftThreadRef = useRef<{ threadId: string } | null>(null);

  const draftDefaultsQuery = useQuery({
    enabled: isDraftPane && !draftComposerEdited && canCompose,
    queryKey: queryKeys.composerSettings(draftProjectId, composerCwd),
    queryFn: ({ signal }) => api.getComposerSettings(draftProjectId, composerCwd, signal),
  });
  const effectiveDraftSettings = !draftComposerEdited && draftDefaultsQuery.data
    ? normalizePersistedComposerSettings(draftDefaultsQuery.data, paneModels)
    : draftComposerSettings;

  useEffect(() => {
    if (usesDefaultWorkspaceState) return;
    return subscribeLiveEvent(pane.target.executorId, (event) => {
      if (event.kind === "skills.changed") {
        setRemoteSkillsInvalidationGeneration((current) => current + 1);
      }
      if (event.threadId !== existingThreadId) return;
      const contextUsage = contextUsageFromEvent(event);
      if (contextUsage) setRemoteContextUsage(contextUsage);
    });
  }, [existingThreadId, pane.target.executorId, subscribeLiveEvent, usesDefaultWorkspaceState]);

  useEffect(() => {
    createdDraftThreadRef.current = null;
  }, [composerCwd, draftProjectId, pane.id]);

  const paneComposerSettings = isDraftPane
    ? effectiveDraftSettings
    : threadSettings.settings;
  const activeThreadId = existingThreadId;
  const composerSettingsErrorMessage = isDraftPane ? null : threadSettings.error;
  const composerDraftKey = existingThreadId
    ? `executor:${pane.target.executorId}:pane:${pane.id}:thread:${existingThreadId}`
    : `executor:${pane.target.executorId}:pane:${pane.id}:draft`;
  const createDraftThreadForPane = useCallback<ThreadPaneComposerBridgeProps["onCreateDraftThread"]>(
    async (request) => {
      if (!isDraftPane) {
        return onCreateDraftThread(request);
      }
      if (createdDraftThreadRef.current) {
        return createdDraftThreadRef.current;
      }
      if (draftProjectId && !composerCwd) throw new Error("Edit this project to choose one root directory before starting a chat.");
      if (!usesDefaultWorkspaceState) {
        const settings = request.composerSettings ?? effectiveDraftSettings;
        const thread = draftProjectId
          ? await api.createThread(draftProjectId, { ...createThreadOptions(settings), cwd: composerCwd! })
          : await api.createChatThread(request.firstMessageText, createThreadOptions(settings));
        const created = { threadId: thread.id };
        createdDraftThreadRef.current = created;
        return created;
      }
      const hydratedSettings = !draftComposerEdited
        ? await hydrateComposerDefaults(draftProjectId, composerCwd)
        : null;
      const createdThread = await onCreateDraftThread({
        ...request,
        composerSettings: hydratedSettings ?? request.composerSettings,
      });
      createdDraftThreadRef.current = createdThread;
      return createdThread;
    },
    [api, composerCwd, draftComposerEdited, draftProjectId, effectiveDraftSettings, hydrateComposerDefaults, isDraftPane, onCreateDraftThread, usesDefaultWorkspaceState],
  );

  const handleDraftDisposableChange = useCallback((disposable: boolean) => {
    if (isDraftPane) setPaneDraftDisposable(pane.id, disposable && createdDraftThreadRef.current === null);
  }, [isDraftPane, pane.id, setPaneDraftDisposable]);
  const handleTextDraftPresenceChange = useCallback((present: boolean) => {
    setPaneComposerTextDraft(pane.id, present);
  }, [pane.id, setPaneComposerTextDraft]);

  const orchestration = useComposerOrchestration({
    activeSelectedTurnId: paneState.activeTurnId,
    canCompose,
    composerSettings: effectiveDraftSettings,
    draftChatThreadSelected: isDraftPane && draftProjectId === null,
    draftThreadProjectId: isDraftPane ? draftProjectId : null,
    isDraftThreadSelected: isDraftPane,
    onCreateDraftThread: createDraftThreadForPane,
    onError,
    onImagePreviewUrlsChanged,
    onOptimisticUserMessageRemoved: (clientRequestId) => {
      publishThreadPaneTimelineAction({ clientRequestId, executorId: pane.target.executorId, kind: "optimistic_user_removed" });
    },
    onOptimisticUserMessageSent: (clientRequestId) => {
      publishThreadPaneTimelineAction({ clientRequestId, executorId: pane.target.executorId, kind: "optimistic_user_sent" });
    },
    onOptimisticUserMessageStarted: ({ clientRequestId, skillMentions, text, threadId }) => {
      publishThreadPaneTimelineAction({
        clientRequestId,
        executorId: pane.target.executorId,
        kind: "optimistic_user_started",
        skillMentions,
        text,
        threadId,
      });
    },
    onThreadMaterialized: (threadId) => {
      createdDraftThreadRef.current = null;
      if (usesDefaultWorkspaceState) onThreadMaterialized(threadId);
      paneState.materializeThreadPane?.(threadId, null);
    },
    onThreadTurnStartFailed: (threadId) => { if (usesDefaultWorkspaceState) onThreadTurnStartFailed(threadId); },
    onThreadTurnStarted: (threadId) => { if (usesDefaultWorkspaceState) onThreadTurnStarted(threadId); },
    selectedProjectId: isDraftPane ? draftProjectId : null,
    selectedThreadId: activeThreadId,
  });

  function handleComposerSettingsChange(change: ComposerSettingsChange) {
    if (!existingThreadId) {
      setDraftComposerEdited(true);
      setDraftComposerSettings(applyDraftComposerSettingsChange(effectiveDraftSettings, change, paneModels));
      return;
    }
    threadSettings.update(change);
  }

  function handleDraftProjectChange(projectId: string | null) {
    void updatePane(pane.id, {
      target: { executorId: pane.target.executorId, mode: "draft", projectId },
    }).catch((error: unknown) => {
      onError(error);
    });
  }

  if (isNativeReadOnly) {
    return <Alert mx="md" my="sm">This native subagent does not accept direct input.</Alert>;
  }

  return (
    <>
    {isDraftPane && draftProjectId && !composerCwd ? (
      <Alert color="red" mx="md" mt="xs">
        Edit this project to choose one root directory before starting a chat.
      </Alert>
    ) : null}
    {!isDraftPane && threadSettings.error ? (
      <Alert color="red" title="Chat settings error" mx="md" mt="xs">
        {threadSettings.error}
        <Button variant="subtle" size="compact-sm" onClick={threadSettings.reload}>Reload settings</Button>
      </Alert>
    ) : null}
    <ComposerPanel
      activeSelectedTurnId={paneState.activeTurnId}
      attachmentInputRef={attachmentInputRef}
      canCompose={canCompose}
      composerDraftKey={composerDraftKey}
      composerDraftStore={composerDraftStore}
      onDraftDisposableChange={handleDraftDisposableChange}
      onTextDraftPresenceChange={handleTextDraftPresenceChange}
      composerResetToken={0}
      composerSettings={paneComposerSettings}
      composerSettingsDisabled={!isDraftPane && threadSettings.pending}
      composerSettingsError={composerSettingsErrorMessage}
      composerCwd={composerCwd}
      composerShellRef={composerShellRef}
      contextUsage={existingThreadId
        ? usesDefaultWorkspaceState ? contextUsageByThreadId[existingThreadId] ?? null : remoteContextUsage
        : null}
      currentProjectName={currentProject?.name ?? null}
      draftProjectSelector={
        isDraftPane
          ? {
              onChange: handleDraftProjectChange,
              projects: paneProjects,
              value: draftProjectId,
            }
          : undefined
      }
      isDraftThreadSelected={isDraftPane}
      isDraftComposerTransitioning={isDraftComposerTransitioning}
      isComposerDragActive={orchestration.isComposerDragActive}
      isComposerSubmitting={orchestration.isComposerSubmitting}
      isSelectedTimelineReady={paneState.isReady}
      skillsInvalidationGeneration={usesDefaultWorkspaceState ? skillsInvalidationGeneration : remoteSkillsInvalidationGeneration}
      models={paneModels}
      onAttachmentInputChange={orchestration.handleAttachmentInputChange}
      onComposerDragLeave={orchestration.handleComposerDragLeave}
      onComposerDragOver={orchestration.handleComposerDragOver}
      onComposerDrop={orchestration.handleComposerDrop}
      onComposerKeyDown={orchestration.handleComposerKeyDown}
      onComposerPaste={orchestration.handleComposerPaste}
      onComposerSettingsChange={handleComposerSettingsChange}
      onImageOpen={onImageOpen}
      onRemovePendingAttachment={orchestration.removePendingAttachment}
      onStopTurn={orchestration.handleStopTurn}
      onSubmitTurn={orchestration.handleSubmitTurn}
      pendingAttachments={orchestration.pendingAttachments}
      goalThreadId={inputStateReadable ? existingThreadId : null}
      queueThreadId={inputStateReadable ? existingThreadId : null}
      paneActive={paneState.isActive}
      selectedThreadPresent={!isDraftPane}
    />
    </>
  );
});
