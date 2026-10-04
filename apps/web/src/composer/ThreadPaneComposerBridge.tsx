import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Autocomplete, Box } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listQueuedInputs, type Project, type QueuedInput } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { ComposerSettings, ContextUsage } from "../ComposerFooterControls";
import type { ImageLightboxImage } from "../images/types";
import { mergeQueuedInputData } from "../queuedInputs/cache";
import { createClientRequestId } from "../shared/id";
import { singleProjectRoot } from "../projects/roots";
import { useWorkspace, type ThreadComposerState } from "../workspace/WorkspaceProvider";
import { paneTargetRecord, type WorkspacePane } from "../workspace/paneTypes";
import { ComposerPanel } from "./ComposerPanel";
import { composerSettingsFromThread, sameComposerSettings } from "./settings";
import type { ComposerDraftStore } from "./useComposerDraftState";
import { useComposerOrchestration } from "./useComposerOrchestration";
import type { useComposerSettingsState } from "./useComposerSettingsState";

const EMPTY_QUEUED_INPUTS: QueuedInput[] = [];

type ThreadPaneComposerBridgeProps = {
  composerDefaults: ComposerSettings;
  contextUsageByThreadId: Record<string, ContextUsage>;
  composerSettingsError: string | null;
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
  onPaneComposerSettingsChange: (paneId: string, settings: ComposerSettings) => void;
  onThreadMaterialized: (threadId: string) => void;
  onThreadTurnStartFailed: (threadId: string) => void;
  onThreadTurnStarted: (threadId: string) => void;
  paneComposerSettingsByPaneId: Record<string, ComposerSettings>;
  pane: WorkspacePane;
  paneState: ThreadComposerState;
  projects: Project[];
  skillsInvalidationGeneration: number;
  threadComposerDefaults: ComposerSettings;
};

export const ThreadPaneComposerBridge = memo(function ThreadPaneComposerBridge({
  composerDefaults,
  contextUsageByThreadId,
  composerDraftStore,
  composerSettingsError,
  hydrateComposerDefaults,
  isDraftComposerTransitioning,
  models,
  onCreateDraftThread,
  onError,
  onImageOpen,
  onImagePreviewUrlsChanged,
  onQueuedInputDeleted,
  onQueuedInputUpsert,
  onPaneComposerSettingsChange,
  onThreadMaterialized,
  onThreadTurnStartFailed,
  onThreadTurnStarted,
  paneComposerSettingsByPaneId,
  pane,
  paneState,
  projects,
  skillsInvalidationGeneration,
  threadComposerDefaults,
}: ThreadPaneComposerBridgeProps) {
  const queryClientForPane = useQueryClient();
  const { publishThreadPaneTimelineAction, updatePane } = useWorkspace();
  const target = paneTargetRecord(pane);
  const existingThreadId = target.mode === "existing" && typeof target.threadId === "string" ? target.threadId : null;
  const isDraftPane = existingThreadId === null;
  const draftProjectId = target.mode === "draft" && typeof target.projectId === "string" ? target.projectId : null;
  const thread = paneState.thread ?? null;
  const currentProject = draftProjectId ? projects.find((project) => project.id === draftProjectId) ?? null : null;
  const explicitCwd = typeof target.cwd === "string" ? target.cwd : null;
  const composerCwd = thread?.cwd ?? (explicitCwd !== null ? explicitCwd.trim() || null : singleProjectRoot(currentProject));
  const canCompose = !isDraftPane || draftProjectId === null || (currentProject !== null && composerCwd !== null);
  const [draftComposerEdited, setDraftComposerEdited] = useState(false);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(composerDefaults);
  const [threadCwdDefaults, setThreadCwdDefaults] = useState<ComposerSettings | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const createdDraftThreadRef = useRef<{ composerSettings: ComposerSettings; threadId: string } | null>(null);

  useEffect(() => {
    if ((isDraftPane && (draftComposerEdited || (draftProjectId !== null && composerCwd === null))) ||
      (!isDraftPane && (!thread || composerSettingsFromThread(thread)))) {
      return;
    }
    let cancelled = false;
    void hydrateComposerDefaults(isDraftPane ? draftProjectId : thread?.projectId ?? null, composerCwd).then((settings) => {
      if (!cancelled && settings) {
        if (isDraftPane) setDraftComposerSettings((current) => (sameComposerSettings(current, settings) ? current : settings));
        else setThreadCwdDefaults((current) => current && sameComposerSettings(current, settings) ? current : settings);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [composerCwd, draftComposerEdited, draftProjectId, hydrateComposerDefaults, isDraftPane, thread?.id, thread?.model, thread?.projectId, thread?.reasoningEffort, thread?.serviceTier]);

  useEffect(() => {
    if (!thread?.id) {
      return;
    }
    const canonicalSettings = composerSettingsFromThread(thread);
    if (canonicalSettings) {
      createdDraftThreadRef.current = null;
      onPaneComposerSettingsChange(pane.id, canonicalSettings);
      return;
    }
    const createdThread = createdDraftThreadRef.current;
    if (createdThread?.threadId === thread.id) {
      onPaneComposerSettingsChange(pane.id, createdThread.composerSettings);
    }
  }, [
    onPaneComposerSettingsChange,
    pane.id,
    thread?.id,
    thread?.model,
    thread?.reasoningEffort,
    thread?.serviceTier,
  ]);

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

  const baseThreadComposerSettings = thread ? composerSettingsFromThread(thread) : null;
  const storedPaneComposerSettings = paneComposerSettingsByPaneId[pane.id];
  const paneComposerSettings = isDraftPane
    ? draftComposerSettings
    : storedPaneComposerSettings ?? baseThreadComposerSettings ?? threadCwdDefaults ?? threadComposerDefaults;
  const activeThreadId = existingThreadId;
  const queuedSteerRows = existingThreadId ? queuedInputsQuery.data ?? EMPTY_QUEUED_INPUTS : EMPTY_QUEUED_INPUTS;
  const composerSettingsErrorMessage = composerSettingsError;
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
      onPaneComposerSettingsChange(pane.id, createdThread.composerSettings);
      return createdThread;
    },
    [composerCwd, draftComposerEdited, draftProjectId, hydrateComposerDefaults, isDraftPane, onCreateDraftThread, onPaneComposerSettingsChange, pane.id],
  );

  const orchestration = useComposerOrchestration({
    activeSelectedTurnId: paneState.activeTurnId,
    canCompose,
    composerSettings: paneComposerSettings,
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

  function handleComposerSettingsChange(nextSettings: ComposerSettings) {
    if (!existingThreadId) {
      setDraftComposerEdited(true);
      setDraftComposerSettings(nextSettings);
      return;
    }
    onPaneComposerSettingsChange(pane.id, nextSettings);
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
    <ComposerPanel
      activeSelectedTurnId={paneState.activeTurnId}
      attachmentInputRef={attachmentInputRef}
      canCompose={canCompose}
      composerDraftKey={composerDraftKey}
      composerDraftStore={composerDraftStore}
      composerResetToken={0}
      composerSettings={paneComposerSettings}
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
