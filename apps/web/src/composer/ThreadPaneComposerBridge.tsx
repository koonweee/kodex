import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Alert, Autocomplete, Box, Button } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listQueuedInputs, type Project, type QueuedInput } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings, ComposerSettingsChange, ContextUsage } from "../ComposerFooterControls";
import type { ImageLightboxImage } from "../images/types";
import { mergeQueuedInputData } from "../queuedInputs/cache";
import { createClientRequestId } from "../shared/id";
import { singleProjectRoot } from "../projects/roots";
import { useWorkspace, type ThreadComposerState } from "../workspace/WorkspaceProvider";
import { paneTargetRecord, type WorkspacePane } from "../workspace/paneTypes";
import { ComposerPanel } from "./ComposerPanel";
import { applyDraftComposerSettingsChange, sameComposerSettings } from "./settings";
import type { ComposerDraftStore } from "./useComposerDraftState";
import { useComposerOrchestration } from "./useComposerOrchestration";
import type { useComposerSettingsState } from "./useComposerSettingsState";
import { useThreadSettings } from "./useThreadSettings";

const EMPTY_QUEUED_INPUTS: QueuedInput[] = [];

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
  onQueuedInputDeleted: (threadId: string, queueId: string) => void;
  onQueuedInputUpsert: (row: QueuedInput) => void;
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
  onQueuedInputDeleted,
  onQueuedInputUpsert,
  onThreadMaterialized,
  onThreadTurnStartFailed,
  onThreadTurnStarted,
  pane,
  paneState,
  projects,
  skillsInvalidationGeneration,
}: ThreadPaneComposerBridgeProps) {
  const queryClientForPane = useQueryClient();
  const { publishThreadPaneTimelineAction, updatePane } = useWorkspace();
  const target = paneTargetRecord(pane);
  const existingThreadId = target.mode === "existing" && typeof target.threadId === "string" ? target.threadId : null;
  const isDraftPane = existingThreadId === null;
  const threadSettings = useThreadSettings(existingThreadId);
  const draftProjectId = target.mode === "draft" && typeof target.projectId === "string" ? target.projectId : null;
  const thread = paneState.thread ?? null;
  const currentProject = draftProjectId ? projects.find((project) => project.id === draftProjectId) ?? null : null;
  const explicitCwd = typeof target.cwd === "string" ? target.cwd : null;
  const composerCwd = thread?.cwd ?? (explicitCwd !== null ? explicitCwd.trim() || null : singleProjectRoot(currentProject));
  const canCompose = !isDraftPane || draftProjectId === null || (currentProject !== null && composerCwd !== null);
  const [draftComposerEdited, setDraftComposerEdited] = useState(false);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(composerDefaults);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const createdDraftThreadRef = useRef<{ threadId: string } | null>(null);

  useEffect(() => {
    if (!isDraftPane || draftComposerEdited || (draftProjectId !== null && composerCwd === null)) {
      return;
    }
    let cancelled = false;
    void hydrateComposerDefaults(draftProjectId, composerCwd).then((settings) => {
      if (!cancelled && settings) {
        setDraftComposerSettings((current) => (sameComposerSettings(current, settings) ? current : settings));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [composerCwd, draftComposerEdited, draftProjectId, hydrateComposerDefaults, isDraftPane]);

  useEffect(() => {
    createdDraftThreadRef.current = null;
  }, [composerCwd, draftProjectId, pane.id]);

  const queuedInputsQuery = useQuery({
    enabled: existingThreadId !== null,
    queryKey: existingThreadId ? queryKeys.queuedInputs(existingThreadId) : ["queued-inputs", "pane", pane.id, "none"],
    queryFn: async () => {
      if (!existingThreadId) {
        return [];
      }
      const snapshot = await listQueuedInputs(existingThreadId);
      return mergeQueuedInputData(
        queryClientForPane.getQueryData<QueuedInput[]>(queryKeys.queuedInputs(existingThreadId)),
        snapshot,
        queryClientForPane.getQueryData<string[]>(queryKeys.queuedInputTombstones(existingThreadId)) ?? [],
      );
    },
  });

  const paneComposerSettings = isDraftPane
    ? draftComposerSettings
    : threadSettings.settings;
  const activeThreadId = existingThreadId;
  const queuedSteerRows = existingThreadId ? queuedInputsQuery.data ?? EMPTY_QUEUED_INPUTS : EMPTY_QUEUED_INPUTS;
  const composerSettingsErrorMessage = isDraftPane ? null : threadSettings.error;
  const composerDraftKey = existingThreadId
    ? `pane:${pane.id}:thread:${existingThreadId}`
    : `pane:${pane.id}:draft:${draftProjectId ?? "chat"}`;
  const createDraftThreadForPane = useCallback<ThreadPaneComposerBridgeProps["onCreateDraftThread"]>(
    async (request) => {
      if (!isDraftPane) {
        return onCreateDraftThread(request);
      }
      if (createdDraftThreadRef.current) {
        return createdDraftThreadRef.current;
      }
      if (draftProjectId && !composerCwd) throw new Error("Choose a working directory before starting this chat.");
      const hydratedSettings = !draftComposerEdited
        ? await hydrateComposerDefaults(draftProjectId, composerCwd)
        : null;
      const createdThread = await onCreateDraftThread({
        ...request,
        composerSettings: hydratedSettings ?? request.composerSettings,
        ...(draftProjectId && composerCwd ? { cwd: composerCwd } : {}),
      });
      createdDraftThreadRef.current = createdThread;
      return createdThread;
    },
    [composerCwd, draftComposerEdited, draftProjectId, hydrateComposerDefaults, isDraftPane, onCreateDraftThread],
  );

  const orchestration = useComposerOrchestration({
    activeSelectedTurnId: paneState.activeTurnId,
    canCompose,
    composerSettings: draftComposerSettings,
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
    onOptimisticUserMessageStarted: ({ skillMentions, text, threadId }) => {
      const clientRequestId = createClientRequestId();
      publishThreadPaneTimelineAction({
        clientRequestId,
        kind: "optimistic_user_started",
        skillMentions,
        text,
        threadId,
      });
      return clientRequestId;
    },
    onQueuedInputDeleted,
    onQueuedInputUpsert,
    onThreadMaterialized: (threadId) => {
      createdDraftThreadRef.current = null;
      onThreadMaterialized(threadId);
      paneState.materializeThreadPane?.(threadId, null);
    },
    onThreadTurnStartFailed,
    onThreadTurnStarted,
    queuedSteerRows,
    selectedProjectId: isDraftPane ? draftProjectId : null,
    selectedThreadId: activeThreadId,
  });

  function handleComposerSettingsChange(change: ComposerSettingsChange) {
    if (!existingThreadId) {
      setDraftComposerEdited(true);
      setDraftComposerSettings((current) => applyDraftComposerSettingsChange(current, change, models));
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

  return (
    <>
    {isDraftPane && currentProject ? (
      <Box px="md" pt="xs">
        <Autocomplete label="Working directory" description="This chat's execution directory; it can be outside the project roots." value={explicitCwd ?? composerCwd ?? ""} data={currentProject.roots.map((root) => root.path)} onChange={(cwd) => {
          void updatePane(pane.id, { target: { mode: "draft", projectId: draftProjectId, cwd } }).catch(onError);
        }} />
      </Box>
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
      isQueuedTurnStartPending={orchestration.isQueuedTurnStartPending}
      isSelectedTimelineReady={paneState.isReady}
      skillsInvalidationGeneration={skillsInvalidationGeneration}
      models={models}
      onAbortQueuedSteer={orchestration.handleAbortQueuedSteer}
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
      onSubmitQueuedSteer={orchestration.handleSubmitQueuedSteer}
      onSubmitTurn={orchestration.handleSubmitTurn}
      pendingAttachments={orchestration.pendingAttachments}
      queuedSteerRows={orchestration.queuedSteerRows}
      selectedThreadPresent={!isDraftPane}
    />
    </>
  );
});
