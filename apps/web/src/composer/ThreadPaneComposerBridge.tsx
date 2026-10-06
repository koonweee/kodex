import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import { getComposerSettings, type Project } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings, ComposerSettingsChange, ContextUsage } from "../ComposerFooterControls";
import type { ImageLightboxImage } from "../images/types";
import { singleProjectRoot } from "../projects/roots";
import { useWorkspace, type ThreadComposerState } from "../workspace/WorkspaceProvider";
import { paneTargetRecord, type WorkspacePane } from "../workspace/paneTypes";
import { ComposerPanel } from "./ComposerPanel";
import { applyDraftComposerSettingsChange, normalizePersistedComposerSettings } from "./settings";
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
  const { publishThreadPaneTimelineAction, setPaneDraftDisposable, updatePane } = useWorkspace();
  const target = paneTargetRecord(pane);
  const existingThreadId = target.mode === "existing" && typeof target.threadId === "string" ? target.threadId : null;
  const isDraftPane = existingThreadId === null;
  const thread = paneState.thread ?? null;
  const isNativeReadOnly = thread?.canAcceptDirectInput === false;
  const inputStateReadable = paneState.isReady && !isNativeReadOnly;
  const threadSettings = useThreadSettings(inputStateReadable ? existingThreadId : null);
  const draftProjectId = target.mode === "draft" && typeof target.projectId === "string" ? target.projectId : null;
  const currentProject = draftProjectId ? projects.find((project) => project.id === draftProjectId) ?? null : null;
  const composerCwd = isDraftPane ? singleProjectRoot(currentProject) : thread?.cwd ?? null;
  const canCompose = !isNativeReadOnly && (!isDraftPane || draftProjectId === null || (currentProject !== null && composerCwd !== null));
  const [draftComposerEdited, setDraftComposerEdited] = useState(false);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(composerDefaults);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const createdDraftThreadRef = useRef<{ threadId: string } | null>(null);

  const draftDefaultsQuery = useQuery({
    enabled: isDraftPane && !draftComposerEdited && canCompose,
    queryKey: queryKeys.composerSettings(draftProjectId, composerCwd),
    queryFn: ({ signal }) => getComposerSettings(draftProjectId, composerCwd, signal),
  });
  const effectiveDraftSettings = !draftComposerEdited && draftDefaultsQuery.data
    ? normalizePersistedComposerSettings(draftDefaultsQuery.data, models)
    : draftComposerSettings;

  useEffect(() => {
    createdDraftThreadRef.current = null;
  }, [composerCwd, draftProjectId, pane.id]);

  const paneComposerSettings = isDraftPane
    ? effectiveDraftSettings
    : threadSettings.settings;
  const activeThreadId = existingThreadId;
  const composerSettingsErrorMessage = isDraftPane ? null : threadSettings.error;
  const composerDraftKey = existingThreadId
    ? `pane:${pane.id}:thread:${existingThreadId}`
    : `pane:${pane.id}:draft`;
  const createDraftThreadForPane = useCallback<ThreadPaneComposerBridgeProps["onCreateDraftThread"]>(
    async (request) => {
      if (!isDraftPane) {
        return onCreateDraftThread(request);
      }
      if (createdDraftThreadRef.current) {
        return createdDraftThreadRef.current;
      }
      if (draftProjectId && !composerCwd) throw new Error("Edit this project to choose one root directory before starting a chat.");
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
    [composerCwd, draftComposerEdited, draftProjectId, hydrateComposerDefaults, isDraftPane, onCreateDraftThread],
  );

  const handleDraftDisposableChange = useCallback((disposable: boolean) => {
    if (isDraftPane) setPaneDraftDisposable(pane.id, disposable && createdDraftThreadRef.current === null);
  }, [isDraftPane, pane.id, setPaneDraftDisposable]);

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
      publishThreadPaneTimelineAction({ clientRequestId, kind: "optimistic_user_removed" });
    },
    onOptimisticUserMessageSent: (clientRequestId) => {
      publishThreadPaneTimelineAction({ clientRequestId, kind: "optimistic_user_sent" });
    },
    onOptimisticUserMessageStarted: ({ clientRequestId, skillMentions, text, threadId }) => {
      publishThreadPaneTimelineAction({
        clientRequestId,
        kind: "optimistic_user_started",
        skillMentions,
        text,
        threadId,
      });
    },
    onThreadMaterialized: (threadId) => {
      createdDraftThreadRef.current = null;
      onThreadMaterialized(threadId);
      paneState.materializeThreadPane?.(threadId, null);
    },
    onThreadTurnStartFailed,
    onThreadTurnStarted,
    selectedProjectId: isDraftPane ? draftProjectId : null,
    selectedThreadId: activeThreadId,
  });

  function handleComposerSettingsChange(change: ComposerSettingsChange) {
    if (!existingThreadId) {
      setDraftComposerEdited(true);
      setDraftComposerSettings(applyDraftComposerSettingsChange(effectiveDraftSettings, change, models));
      return;
    }
    threadSettings.update(change);
  }

  function handleDraftProjectChange(projectId: string | null) {
    void updatePane(pane.id, {
      target: { mode: "draft", projectId },
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
      composerResetToken={0}
      composerSettings={paneComposerSettings}
      composerSettingsDisabled={!isDraftPane && threadSettings.pending}
      composerSettingsError={composerSettingsErrorMessage}
      composerCwd={composerCwd}
      composerShellRef={composerShellRef}
      contextUsage={existingThreadId ? contextUsageByThreadId[existingThreadId] ?? null : null}
      currentProjectName={currentProject?.name ?? null}
      draftProjectSelector={
        isDraftPane
          ? {
              onChange: handleDraftProjectChange,
              projects,
              value: draftProjectId,
            }
          : undefined
      }
      selectedGitBranch={thread?.gitInfo?.branch ?? null}
      isDraftThreadSelected={isDraftPane}
      isDraftComposerTransitioning={isDraftComposerTransitioning}
      isComposerDragActive={orchestration.isComposerDragActive}
      isComposerSubmitting={orchestration.isComposerSubmitting}
      isSelectedTimelineReady={paneState.isReady}
      skillsInvalidationGeneration={skillsInvalidationGeneration}
      models={models}
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
      queueDialogActive={paneState.isActive}
      selectedThreadPresent={!isDraftPane}
    />
    </>
  );
});
