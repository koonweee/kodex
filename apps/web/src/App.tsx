import { MantineProvider } from "@mantine/core";
import { QueryClientProvider, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";

import { useApprovalsState } from "./approvals/useApprovalsState";
import {
  formatUsageLimitLines,
  usageLimitSnapshotFromResponse,
} from "./account/rateLimits";
import { useAccountSession } from "./account/useAccountSession";
import {
  archiveThread,
  createAutomation,
  createChatThread,
  createProject,
  createThread,
  deleteAutomation,
  getCapabilities,
  getRateLimits,
  listAutomations,
  listChatThreadsPage,
  listQueuedInputs,
  listPinnedThreads,
  listProjects,
  listThreadSubagents,
  listThreadsPage,
  pauseAutomation,
  pinThread,
  renameThread,
  resumeAutomation,
  setThreadNotificationsEnabled,
  unpinThread,
  updateAutomation,
  type Approval,
  type Automation,
  type AutomationCreateRequest,
  type AutomationUpdateRequest,
  type EventEnvelope,
  type Project,
  type QueuedInput,
  type ThreadSubagentSummary,
  type ThreadSummary,
} from "./api/client";
import { queryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import {
  deleteCachedAutomation,
  mergeAutomationData,
  upsertCachedAutomation,
} from "./automations/cache";
import { ComposerPanel } from "./composer/ComposerPanel";
import type { ComposerSettings, ContextUsage } from "./ComposerFooterControls";
import type { ComposerDraftStore } from "./composer/useComposerDraftState";
import { automationThreadOptions } from "./automations/threadOptions";
import { composerSettingsFromThread, createThreadOptions, sameComposerSettings } from "./composer/settings";
import { useComposerSettingsState } from "./composer/useComposerSettingsState";
import { useComposerOrchestration } from "./composer/useComposerOrchestration";
import { installLiveLongTaskObserver } from "./events/liveDiagnostics";
import { routeGlobalLiveEvent } from "./events/liveRouting";
import { useLiveEventHandlers } from "./events/useLiveEventHandlers";
import type { MarkdownPreviewRequest } from "./files/types";
import type { ImageLightboxImage } from "./images/types";
import { useKodexNotifications } from "./notifications/useKodexNotifications";
import { PwaLifecycle } from "./pwa/PwaLifecycle";
import type { PreferenceSection } from "./PreferencesModal";
import {
  applyKodexColorScheme,
  createKodexMantineTheme,
  getKodexColorScheme,
  readStoredKodexColorScheme,
  writeStoredKodexColorScheme,
  type KodexColorSchemeId,
} from "./theme";
import { idleTimelineEntry, type TimelineEntry } from "./timeline/entry";
import { useSelectedThreadTimeline, type ThreadSyncNotice } from "./timeline/useSelectedThreadTimeline";
import {
  clearAvailableThreadTitles,
  markThreadTitlePending,
  optimisticThreadSummary,
  withPinnedProjectThreads,
  withoutPinnedThreads,
  type ThreadsByProjectId,
} from "./threads/helpers";
import {
  mergeChatThreadData,
  mergePinnedThreadData,
  mergeProjectThreadData,
  mergeProjectThreadSnapshot,
  pinnedTombstonesAddedDuringSnapshot,
  removeThreadEverywhere,
  upsertChatThread,
  upsertProjectThread,
} from "./threads/cache";
import {
  deleteCachedQueuedInput,
  mergeQueuedInputData,
  upsertCachedQueuedInput,
} from "./queuedInputs/cache";
import type { ThreadSubagentDiscoveryEvent } from "./threads/events";
import {
  defaultSubagent,
} from "./threads/selection";
import { useSelectedThreadAttach } from "./threads/useSelectedThreadAttach";
import { useSidebarThreadCaches } from "./threads/useSidebarThreadCaches";
import {
  applySidebarProjectOrder,
  loadSidebarProjectOrder,
  saveSidebarProjectOrder,
} from "./threads/projectOrder";
import { useSidebarThreadsSnapshot } from "./threads/useSidebarThreadsSnapshot";
import { useThreadMetadata } from "./threads/useThreadMetadata";
import { useThreadReadState } from "./threads/useThreadReadState";
import { useThreadViewPresence } from "./threads/useThreadViewPresence";
import { AdaptiveIconButton } from "./ui/AdaptiveIconButton";
import { paneTargetRecord } from "./workspace/paneTypes";
import { createTimelineState, type TimelineState } from "./timeline/reducer";
import { errorMessageFrom } from "./shared/values";
import { createClientRequestId } from "./shared/id";
import { KodexShellView, useNarrowThreadWorkspace } from "./shell/KodexShellView";
import {
  currentKodexRoute,
  pushKodexRoute,
} from "./shell/browserRouting";
import { queryResultLoadState } from "./shell/queryResultLoadState";
import { useSidebarResize } from "./shell/useSidebarResize";
import { useShellSelection } from "./shell/useShellSelection";
import {
  WorkspaceProvider,
  useWorkspace,
  type ThreadComposerState,
  type ThreadPaneTimelineAction,
  type ThreadPaneTimelineActionHandler,
} from "./workspace/WorkspaceProvider";
import type { WorkspacePaneStoreAdapter } from "./workspace/paneStore";
import type { WorkspacePane } from "./workspace/paneTypes";
import "./App.css";

const DRAFT_COMPOSER_TRANSITION_MS = 280;
const EMPTY_AUTOMATIONS: Automation[] = [];
const EMPTY_PROJECTS: Project[] = [];
const EMPTY_QUEUED_INPUTS: QueuedInput[] = [];
const EMPTY_SUBAGENTS: ThreadSubagentSummary[] = [];
const EMPTY_THREADS: ThreadSummary[] = [];
type SidebarPaginationState = "idle" | "loading" | "error";

const ImageLightbox = lazy(() =>
  import("./images/ImageLightbox").then((module) => ({ default: module.ImageLightbox })),
);
const MarkdownPreviewPane = lazy(() =>
  import("./files/MarkdownPreviewPane").then((module) => ({ default: module.MarkdownPreviewPane })),
);
const SubagentThreadViewer = lazy(() =>
  import("./threads/SubagentThreadViewer").then((module) => ({ default: module.SubagentThreadViewer })),
);
const ThemeWorkbench = lazy(() =>
  import("./theme/ThemeWorkbench").then((module) => ({ default: module.ThemeWorkbench })),
);

function useEventCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}

type AppProps = {
  queryClientInstance?: QueryClient;
  workspacePaneStore?: WorkspacePaneStoreAdapter;
};

type ThreadPaneComposerBridgeProps = {
  composerDefaults: ComposerSettings;
  contextUsageByThreadId: Record<string, ContextUsage>;
  composerSettingsError: string | null;
  composerDraftStore: ComposerDraftStore;
  hydrateComposerDefaults: (projectId: string | null) => Promise<ComposerSettings | null>;
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
  const [draftComposerEdited, setDraftComposerEdited] = useState(false);
  const [draftComposerSettings, setDraftComposerSettings] = useState<ComposerSettings>(composerDefaults);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const createdDraftThreadRef = useRef<{ composerSettings: ComposerSettings; threadId: string } | null>(null);

  useEffect(() => {
    if (!isDraftPane || draftComposerEdited) {
      return;
    }
    setDraftComposerSettings((current) => (sameComposerSettings(current, composerDefaults) ? current : composerDefaults));
  }, [composerDefaults, draftComposerEdited, isDraftPane]);

  useEffect(() => {
    if (!isDraftPane || draftComposerEdited) {
      return;
    }
    let cancelled = false;
    void hydrateComposerDefaults(draftProjectId).then((settings) => {
      if (!cancelled && settings) {
        setDraftComposerSettings((current) => (sameComposerSettings(current, settings) ? current : settings));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draftComposerEdited, draftProjectId, hydrateComposerDefaults, isDraftPane]);

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
  }, [draftProjectId, pane.id]);

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
    : storedPaneComposerSettings ?? baseThreadComposerSettings ?? threadComposerDefaults;
  const currentProject =
    draftProjectId ? projects.find((project) => project.id === draftProjectId) ?? null : null;
  const composerCwd = thread?.cwd ?? currentProject?.cwd ?? null;
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
      const createdThread = await onCreateDraftThread(request);
      createdDraftThreadRef.current = createdThread;
      onPaneComposerSettingsChange(pane.id, createdThread.composerSettings);
      return createdThread;
    },
    [isDraftPane, onCreateDraftThread, onPaneComposerSettingsChange, pane.id],
  );

  const orchestration = useComposerOrchestration({
    activeSelectedTurnId: paneState.activeTurnId,
    canCompose: true,
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
    <ComposerPanel
      activeSelectedTurnId={paneState.activeTurnId}
      attachmentInputRef={attachmentInputRef}
      canCompose
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
  );
});

export function App({ queryClientInstance = queryClient, workspacePaneStore }: AppProps = {}) {
  const [colorSchemeId, setColorSchemeId] = useState<KodexColorSchemeId>(() => readStoredKodexColorScheme());
  const colorScheme = useMemo(() => getKodexColorScheme(colorSchemeId), [colorSchemeId]);
  const theme = useMemo(() => createKodexMantineTheme(colorScheme), [colorScheme]);

  useLayoutEffect(() => {
    writeStoredKodexColorScheme(colorSchemeId);
    applyKodexColorScheme(document.documentElement, colorScheme);
  }, [colorScheme, colorSchemeId]);

  useEffect(() => installLiveLongTaskObserver(), []);

  const isThemeWorkbench = typeof window !== "undefined" && window.location.pathname === "/__theme";

  return (
    <QueryClientProvider client={queryClientInstance}>
      <MantineProvider forceColorScheme={colorScheme.mode} theme={theme}>
        <PwaLifecycle />
        {isThemeWorkbench ? (
          <Suspense fallback={null}>
            <ThemeWorkbench colorSchemeId={colorSchemeId} onColorSchemeChange={setColorSchemeId} />
          </Suspense>
        ) : (
          <KodexShell
            colorSchemeId={colorSchemeId}
            onColorSchemeChange={setColorSchemeId}
            workspacePaneStore={workspacePaneStore}
          />
        )}
      </MantineProvider>
    </QueryClientProvider>
  );
}

function KodexShell({
  colorSchemeId,
  onColorSchemeChange,
  workspacePaneStore,
}: {
  colorSchemeId: KodexColorSchemeId;
  onColorSchemeChange: (colorSchemeId: KodexColorSchemeId) => void;
  workspacePaneStore?: WorkspacePaneStoreAdapter;
}) {
  const [initialRoute] = useState(() => currentKodexRoute());
  const queryClientForShell = useQueryClient();
  const useSingleThreadWorkspace = useNarrowThreadWorkspace();
  const [projectOrderIds, setProjectOrderIds] = useState<string[] | null>(() => loadSidebarProjectOrder());
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [, setTimeline] = useState<TimelineState>(createTimelineState());
  const [, setTimelineEntry] = useState<TimelineEntry>(() =>
    initialRoute.threadId ? { phase: "loadingSnapshot", threadId: initialRoute.threadId } : idleTimelineEntry,
  );
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectCwd, setProjectCwd] = useState("");
  const [projectDirectoryCreateCwd, setProjectDirectoryCreateCwd] = useState<string | null>(null);
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setThreadSyncNotice] = useState<ThreadSyncNotice | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewRequest | null>(null);
  const [paneComposerSettingsByPaneId, setPaneComposerSettingsByPaneId] = useState<Record<string, ComposerSettings>>({});
  const [paneImagePreviewUrlsByPath, setPaneImagePreviewUrlsByPath] = useState<Record<string, string>>({});
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferenceSection>("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [threadPaneSnapshotReadyIds, setThreadPaneSnapshotReadyIds] = useState<Set<string>>(new Set());
  const [subagentSidebarOpen, setSubagentSidebarOpen] = useState(false);
  const [selectedSubagentThreadId, setSelectedSubagentThreadId] = useState<string | null>(null);
  const [, setComposerResetToken] = useState(0);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const approvalsRef = useRef<Approval[]>([]);
  const attachingThreadIdsRef = useRef<Set<string>>(new Set());
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const pinnedThreadsRef = useRef<ThreadSummary[]>([]);
  const pendingTitleThreadIdsRef = useRef<Set<string>>(new Set());
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const composerDefaultsRef = useRef({
    draftComposerEditedRef: { current: false },
    hydrateComposerDefaults: (_projectId: string | null) => undefined as void | Promise<unknown>,
  });
  const chatThreadsLoadingCursorRef = useRef<string | null>(null);
  const projectThreadLoadingCursorsRef = useRef<Record<string, string>>({});
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const composerDraftStoreRef = useRef<ComposerDraftStore>(new Map());
  const activeDraftComposerPaneIdRef = useRef<string | null>(null);
  const activeDraftComposerThreadIdRef = useRef<string | null>(null);
  const threadPaneTimelineActionHandlersRef = useRef(new Set<ThreadPaneTimelineActionHandler>());
  const draftComposerTransitionOriginRef = useRef<DOMRect | null>(null);
  const liveUsageLimitSnapshotReceivedRef = useRef(false);
  const [draftComposerTransitionToken, setDraftComposerTransitionToken] = useState(0);
  const [isDraftComposerTransitioning, setIsDraftComposerTransitioning] = useState(false);
  const [pinnedStateTrusted, setPinnedStateTrusted] = useState(false);
  const [chatThreadsNextCursor, setChatThreadsNextCursor] = useState<string | null>(null);
  const [projectThreadNextCursors, setProjectThreadNextCursors] = useState<Record<string, string | null>>({});
  const [chatThreadsPaginationState, setChatThreadsPaginationState] = useState<SidebarPaginationState>("idle");
  const [projectThreadPaginationStateById, setProjectThreadPaginationStateById] = useState<Record<string, SidebarPaginationState>>({});
  const [visibleThreadIds, setVisibleThreadIds] = useState<string[]>([]);
  const visibleThreadIdsRef = useRef<Set<string>>(new Set());

  const {
    clearSelectionToDraft,
    draftChatThreadSelected,
    draftThreadProjectId,
    handleCreateChat,
    handleCreateThread,
    handleFocusWorkspaceThreadPane,
    handleSelectAutomations,
    handleSelectChatThread,
    handleSelectPinnedThread,
    handleSelectProjectSettings,
    handleSelectThread,
    mobilePanel,
    routeSelectedThread,
    routeSelectedThreadRef,
    routeThreadPaneId,
    selectMaterializedThread,
    selectProject,
    selectedMainPane,
    selectedProjectId,
    selectedProjectIdRef,
    selectedProjectPaneId,
    selectedThreadId,
    selectedThreadIdRef,
    setMobilePanel,
    setRouteSelectedThreadState,
    setSelectedProjectId,
    setUnavailableThreadId,
    unavailableThreadId,
  } = useShellSelection({
    beginMaterializingTimelineEntry,
    beginTimelineEntry,
    chatThreadsRef,
    clearTimelineEntry,
    composerDefaultsRef,
    initialRoute,
    pinnedThreadsRef,
    resetComposerDraft,
    threadsByProjectIdRef,
  });

  const {
    cachedSidebarSnapshotData,
    scopedSidebarQueriesEnabled,
    scopedSidebarSnapshotStaleTime,
    sidebarSnapshotReady,
    sidebarThreadsQuery,
  } = useSidebarThreadsSnapshot({
    queryClient: queryClientForShell,
    routeSelectedThreadRef,
    selectedThreadIdRef,
    onChatThreadsCursorChange: setChatThreadsNextCursor,
    onPinnedStateTrusted: () => setPinnedStateTrusted(true),
    onProjectThreadCursorsChange: setProjectThreadNextCursors,
  });
  const projectsQuery = useQuery({
    enabled: scopedSidebarQueriesEnabled,
    queryKey: queryKeys.projects,
    refetchOnMount: false,
    staleTime: scopedSidebarSnapshotStaleTime,
    queryFn: async () => {
      const seededProjects = cachedSidebarSnapshotData<Project[]>(queryKeys.projects);
      if (seededProjects) {
        return seededProjects;
      }
      return listProjects();
    },
  });
  const capabilitiesQuery = useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: getCapabilities,
    staleTime: Infinity,
  });
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const orderedProjects = useMemo(() => applySidebarProjectOrder(projects, projectOrderIds), [projectOrderIds, projects]);
  const projectThreadQueries = useQueries({
    queries: orderedProjects.map((project) => ({
      enabled: scopedSidebarQueriesEnabled,
      queryKey: queryKeys.projectThreads(project.id),
      refetchOnMount: false,
      staleTime: scopedSidebarSnapshotStaleTime,
      queryFn: async () => {
        const seededThreads = cachedSidebarSnapshotData<ThreadSummary[]>(queryKeys.projectThreads(project.id));
        if (seededThreads) {
          return seededThreads;
        }
        const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(project.id));
        const response = await listThreadsPage(project.id);
        setProjectThreadNextCursors((current) => ({ ...current, [project.id]: response.nextCursor ?? null }));
        return mergeProjectThreadData(
          queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(project.id)),
          response.threads,
          routeSelectedThreadRef.current,
          selectedThreadIdRef.current,
          beforeSnapshot,
        );
      },
    })),
  });
  const threadsByProjectId = useMemo(() => {
    const next: ThreadsByProjectId = {};
    orderedProjects.forEach((project, index) => {
      next[project.id] = projectThreadQueries[index]?.data ?? EMPTY_THREADS;
    });
    return next;
  }, [orderedProjects, projectThreadQueries]);
  const chatThreadsQuery = useQuery({
    enabled: scopedSidebarQueriesEnabled,
    queryKey: queryKeys.chatThreads,
    refetchOnMount: false,
    staleTime: scopedSidebarSnapshotStaleTime,
    queryFn: async () => {
      const seededThreads = cachedSidebarSnapshotData<ThreadSummary[]>(queryKeys.chatThreads);
      if (seededThreads) {
        return seededThreads;
      }
      const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads);
      const response = await listChatThreadsPage();
      setChatThreadsNextCursor(response.nextCursor ?? null);
      return mergeChatThreadData(
        queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads),
        response.threads,
        beforeSnapshot,
      );
    },
  });
  const pinnedThreadsQuery = useQuery({
    enabled: scopedSidebarQueriesEnabled,
    queryKey: queryKeys.pinnedThreads,
    refetchOnMount: false,
    staleTime: sidebarSnapshotReady || pinnedStateTrusted ? Infinity : 0,
    queryFn: async () => {
      const seededThreads = cachedSidebarSnapshotData<ThreadSummary[]>(queryKeys.pinnedThreads);
      if (seededThreads) {
        return seededThreads;
      }
      const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);
      const tombstonesBeforeSnapshot = queryClientForShell.getQueryData<string[]>(queryKeys.pinnedThreadTombstones);
      const threads = await listPinnedThreads();
      const current = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);
      const tombstones = queryClientForShell.getQueryData<string[]>(queryKeys.pinnedThreadTombstones);
      const tombstonesForSnapshot = pinnedTombstonesAddedDuringSnapshot(tombstonesBeforeSnapshot, tombstones);
      if (tombstones && tombstones.length > 0) {
        queryClientForShell.setQueryData<string[]>(queryKeys.pinnedThreadTombstones, []);
      }
      setPinnedStateTrusted(true);
      return mergePinnedThreadData(
        beforeSnapshot,
        current,
        threads,
        tombstonesForSnapshot,
      );
    },
  });
  const automationsQuery = useQuery({
    enabled: selectedMainPane === "automations",
    queryKey: queryKeys.automations,
    queryFn: async () => {
      const beforeSnapshot = queryClientForShell.getQueryData<Automation[]>(queryKeys.automations);
      const snapshot = await listAutomations();
      const current = queryClientForShell.getQueryData<Automation[]>(queryKeys.automations);
      if (!beforeSnapshot && current && current.length > 0) {
        return current;
      }
      return mergeAutomationData(
        current,
        snapshot,
        queryClientForShell.getQueryData<string[]>(queryKeys.automationTombstones) ?? [],
      );
    },
  });
  const rateLimitsQuery = useQuery({
    queryKey: queryKeys.rateLimits,
    queryFn: async () => {
      const nextSnapshot = usageLimitSnapshotFromResponse(await getRateLimits());
      if (liveUsageLimitSnapshotReceivedRef.current) {
        return queryClientForShell.getQueryData<ReturnType<typeof usageLimitSnapshotFromResponse>>(queryKeys.rateLimits) ?? nextSnapshot;
      }
      return nextSnapshot;
    },
  });
  const createAutomationMutation = useMutation({
    mutationFn: createAutomation,
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const updateAutomationMutation = useMutation({
    mutationFn: ({ automationId, request }: { automationId: string; request: AutomationUpdateRequest }) =>
      updateAutomation(automationId, request),
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const pauseAutomationMutation = useMutation({
    mutationFn: pauseAutomation,
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const resumeAutomationMutation = useMutation({
    mutationFn: resumeAutomation,
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const deleteAutomationMutation = useMutation({
    mutationFn: async (automationId: string) => {
      await deleteAutomation(automationId);
      return automationId;
    },
    onSuccess: (automationId) => deleteCachedAutomation(queryClientForShell, automationId),
  });
  const createProjectMutation = useMutation({ mutationFn: createProject });
  const archiveThreadMutation = useMutation({ mutationFn: archiveThread });
  const renameThreadMutation = useMutation({
    mutationFn: ({ threadId, name }: { threadId: string; name: string }) => renameThread(threadId, name),
    onSuccess: (thread) => replaceThread(thread),
  });
  const pinThreadMutation = useMutation({ mutationFn: pinThread });
  const unpinThreadMutation = useMutation({ mutationFn: unpinThread });
  const threadNotificationsMutation = useMutation({
    mutationFn: ({ threadId, enabled }: { threadId: string; enabled: boolean }) =>
      setThreadNotificationsEnabled(threadId, enabled),
  });
  const chatThreads = chatThreadsQuery.data ?? EMPTY_THREADS;
  const pinnedThreads = pinnedThreadsQuery.data ?? EMPTY_THREADS;
  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? EMPTY_THREADS : EMPTY_THREADS;
  const flatProjectThreads = useMemo(() => Object.values(threadsByProjectId).flat(), [threadsByProjectId]);
  const selectedProjectPane =
    selectedProjectPaneId ? orderedProjects.find((project) => project.id === selectedProjectPaneId) ?? null : null;
  const selectedThread =
    (routeSelectedThread?.id === selectedThreadId ? routeSelectedThread : null) ??
    selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    flatProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    chatThreads.find((thread) => thread.id === selectedThreadId) ??
    pinnedThreads.find((thread) => thread.id === selectedThreadId) ??
    null;
  const threadSummariesById = useMemo(() => {
    const summaries: Record<string, ThreadSummary> = {};
    for (const thread of [...chatThreads, ...pinnedThreads, ...flatProjectThreads]) {
      summaries[thread.id] = thread;
    }
    if (routeSelectedThread) {
      summaries[routeSelectedThread.id] = routeSelectedThread;
    }
    return summaries;
  }, [chatThreads, flatProjectThreads, pinnedThreads, routeSelectedThread]);
  const threadProjectIdsById = useMemo(() => {
    const projectIds: Record<string, string> = {};
    for (const [projectId, threads] of Object.entries(threadsByProjectId)) {
      for (const thread of threads) {
        projectIds[thread.id] = projectId;
      }
    }
    return projectIds;
  }, [threadsByProjectId]);
  const isSelectedThreadSnapshotDeferred =
    selectedThreadId !== null && materializingThreadIds.has(selectedThreadId);
  const isDraftThreadSelected =
    draftChatThreadSelected || (draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId);
  const selectedThreadSubagentsQuery = useQuery({
    enabled:
      selectedMainPane === "thread" &&
      selectedThread !== null &&
      threadPaneSnapshotReadyIds.has(selectedThread.id),
    queryKey: selectedThread ? queryKeys.threadSubagents(selectedThread.id) : ["threads", "none", "subagents"],
    queryFn: async () => {
      const threadId = selectedThread?.id;
      return threadId ? listThreadSubagents(threadId) : [];
    },
  });
  const selectedThreadSubagents = selectedThreadSubagentsQuery.data ?? EMPTY_SUBAGENTS;
  const automations = automationsQuery.data ?? EMPTY_AUTOMATIONS;
  const usageLimitSnapshot = rateLimitsQuery.data ?? null;
  const automationTargetThreadOptions = useMemo(
    () =>
      automationThreadOptions({
        chatThreads,
        pinnedThreads,
        projectThreads: flatProjectThreads,
      }),
    [chatThreads, flatProjectThreads, pinnedThreads],
  );
  const {
    approvals,
    applyApprovalEventWithTombstone,
    handleApprovalDecision,
    setApprovals,
  } = useApprovalsState({ selectedThreadId });
  approvalsRef.current = approvals;
  chatThreadsRef.current = chatThreads;
  pinnedThreadsRef.current = pinnedThreads;
  pendingTitleThreadIdsRef.current = pendingTitleThreadIds;
  threadsByProjectIdRef.current = threadsByProjectId;
  const { account, handleLogout } = useAccountSession({ onError: reportError });
  const {
    applyThreadNotificationsState,
    applyThreadPinState,
    applyThreadUpsert,
    patchThreadEverywhere,
    refreshSidebarThreadsForLiveEvent,
    replaceThread,
  } = useSidebarThreadCaches({
    chatThreadsRef,
    onPinnedStateTrusted: () => setPinnedStateTrusted(true),
    pinnedThreadsRef,
    queryClient: queryClientForShell,
    routeSelectedThreadRef,
    selectedThreadIdRef,
    setPendingTitleThreadIds,
    setRouteSelectedThreadState,
    threadsByProjectIdRef,
  });
  const {
    composerSettings,
    composerSettingsError,
    draftComposerEditedRef,
    hydrateComposerDefaults,
    models,
    workspaceComposerDefaults,
  } = useComposerSettingsState({
    draftChatThreadSelected,
    onError: reportError,
    selectedProjectId,
    selectedThread,
  });
  composerDefaultsRef.current = { draftComposerEditedRef, hydrateComposerDefaults };
  const publishThreadPaneTimelineAction = useEventCallback((action: ThreadPaneTimelineAction) => {
    for (const handler of threadPaneTimelineActionHandlersRef.current) {
      handler(action);
    }
  });
  const subscribeThreadPaneTimelineAction = useEventCallback((handler: ThreadPaneTimelineActionHandler) => {
    threadPaneTimelineActionHandlersRef.current.add(handler);
    return () => {
      threadPaneTimelineActionHandlersRef.current.delete(handler);
    };
  });
  const { applyCompletedAgentTurnEvent, applyThreadReadStateEvent, markCompletedAgentTurnSeen } = useThreadReadState({
    chatThreads,
    onError: reportError,
    selectedThreadIdRef,
    viewedThreadIdsRef: visibleThreadIdsRef,
    threadsByProjectId,
    pinnedThreads,
    updateThreadEverywhere: patchThreadEverywhere,
  });
  useThreadViewPresence({
    enabled: selectedMainPane === "thread",
    threadIds: visibleThreadIds,
  });
  useKodexNotifications({
    chatThreads,
    pinnedThreads,
    routeSelectedThread,
    threadsByProjectId,
  });
  const {
    applyThreadMetadataEvent,
    contextUsageByThreadId,
  } = useThreadMetadata({
    selectedThreadId,
    setPendingTitleThreadIds,
    updateThreadEverywhere: patchThreadEverywhere,
  });
  const {
    handleSidebarCollapseClick,
    handleSidebarExpandClick,
    isSidebarResizing,
    sidebarCollapsed,
    sidebarWidth,
  } = useSidebarResize();
  const imagePreviewUrlsByPath = {};
  const mergedImagePreviewUrlsByPath = useMemo(
    () => ({ ...imagePreviewUrlsByPath, ...paneImagePreviewUrlsByPath }),
    [paneImagePreviewUrlsByPath],
  );
  const usageLimitLines = useMemo(() => formatUsageLimitLines(usageLimitSnapshot), [usageLimitSnapshot]);

  useEffect(() => {
    void hydrateComposerDefaults(null);
  }, []);

  useEffect(() => {
    const loadedThreads = [
      ...chatThreads,
      ...pinnedThreads,
      ...Object.values(threadsByProjectId).flat(),
    ];
    setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, loadedThreads));
  }, [chatThreads, pinnedThreads, threadsByProjectId]);

  useEffect(() => {
    const selectedId = selectedThreadIdRef.current;
    if (!selectedId || selectedProjectIdRef.current) {
      return;
    }
    for (const [projectId, projectThreads] of Object.entries(threadsByProjectId)) {
      if (projectThreads.some((thread) => thread.id === selectedId)) {
        selectedProjectIdRef.current = projectId;
        setSelectedProjectId(projectId);
        void hydrateComposerDefaults(projectId);
        return;
      }
    }
  }, [hydrateComposerDefaults, threadsByProjectId]);

  useEffect(() => {
    setSubagentSidebarOpen(false);
    setSelectedSubagentThreadId(null);
  }, [selectedThreadId]);

  useEffect(() => {
    if (selectedThreadSubagents.length === 0) {
      setSubagentSidebarOpen((current) => (current ? false : current));
      setSelectedSubagentThreadId((current) => (current === null ? current : null));
      return;
    }
    setSelectedSubagentThreadId((current) => {
      if (current && selectedThreadSubagents.some((subagent) => subagent.id === current)) {
        return current;
      }
      return defaultSubagent(selectedThreadSubagents)?.id ?? null;
    });
  }, [selectedThreadSubagents]);

  useLayoutEffect(() => {
    if (draftComposerTransitionToken === 0) {
      return;
    }

    const originRect = draftComposerTransitionOriginRef.current;
    draftComposerTransitionOriginRef.current = null;
    const composerShell = composerShellRef.current;
    if (!originRect || !composerShell) {
      setIsDraftComposerTransitioning(false);
      return;
    }

    const targetRect = composerShell.getBoundingClientRect();
    const deltaX = originRect.left - targetRect.left;
    const deltaY = originRect.top - targetRect.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
      setIsDraftComposerTransitioning(false);
      return;
    }

    const prefersReducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setIsDraftComposerTransitioning(false);
      return;
    }

    const previousTransition = composerShell.style.transition;
    const previousTransform = composerShell.style.transform;
    const previousWillChange = composerShell.style.willChange;
    let frameId = 0;
    let timeoutId = 0;

    composerShell.style.transition = "none";
    composerShell.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    composerShell.style.willChange = "transform";
    composerShell.getBoundingClientRect();

    frameId = window.requestAnimationFrame(() => {
      composerShell.style.transition = `transform ${DRAFT_COMPOSER_TRANSITION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
      composerShell.style.transform = "translate(0, 0)";
      timeoutId = window.setTimeout(() => {
        composerShell.style.transition = previousTransition;
        composerShell.style.transform = previousTransform;
        composerShell.style.willChange = previousWillChange;
        setIsDraftComposerTransitioning(false);
      }, DRAFT_COMPOSER_TRANSITION_MS);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
      composerShell.style.transition = previousTransition;
      composerShell.style.transform = previousTransform;
      composerShell.style.willChange = previousWillChange;
    };
  }, [draftComposerTransitionToken]);

  const { applySelectedThreadStreamEvent, liveRouteHandlers } = useLiveEventHandlers({
    applyApprovalEventWithTombstone,
    applyCompletedAgentTurnEvent,
    applyQueuedInputDeleted: removeQueuedInput,
    applyQueuedInputUpsert: upsertQueuedInput,
    applySubagentDiscoveryEvent,
    applyThreadMetadataEvent,
    applyThreadNotificationsState,
    applyThreadPinState,
    applyThreadReadStateEvent,
    applyThreadUpsert,
    liveUsageLimitSnapshotReceivedRef,
    queryClient: queryClientForShell,
    refreshSidebarThreadsForLiveEvent,
    setApprovals,
    setSkillsInvalidationGeneration,
  });

  const handleWorkspaceLiveEvent = useEventCallback((event: EventEnvelope) => {
    routeGlobalLiveEvent(event, liveRouteHandlers);
  });
  const handleVisibleThreadIdsChange = useEventCallback((threadIds: string[]) => {
    const nextThreadIds = Array.from(new Set(threadIds)).sort();
    visibleThreadIdsRef.current = new Set(nextThreadIds);
    setVisibleThreadIds((current) =>
      current.length === nextThreadIds.length && current.every((threadId, index) => threadId === nextThreadIds[index])
        ? current
        : nextThreadIds,
    );
  });

  useSelectedThreadAttach({
    attachingThreadIdsRef,
    isSelectedThreadSnapshotDeferred,
    onAttachedThread: replaceThread,
    onError: reportError,
    selectedThread,
  });

  useSelectedThreadTimeline({
    isSelectedThreadSnapshotDeferred,
    onApprovalEvent: applyApprovalEventWithTombstone,
    onError: (error) => {
      const threadId = selectedThreadIdRef.current;
      reportError(error, threadId ? `Selected thread load failed (${threadId})` : "Selected thread load failed");
    },
    onSnapshotThread: handleSelectedThreadSnapshot,
    onSyncNotice: setThreadSyncNotice,
    onSelectedThreadEvent: applySelectedThreadStreamEvent,
    onQueueEvent: () => {},
    selectedThreadId: useSingleThreadWorkspace ? selectedThreadId : null,
    setApprovals,
    setTimeline,
    setTimelineEntry,
    onThreadLoadFailed: handleSelectedThreadLoadFailed,
  });

  function clearTimelineEntry() {
    setTimelineEntry(idleTimelineEntry);
    setTimeline(createTimelineState());
  }

  function beginTimelineEntry(threadId: string) {
    markCompletedAgentTurnSeen(threadId);
    setTimeline(createTimelineState());
    setTimelineEntry({ phase: "loadingSnapshot", threadId });
  }

  function beginMaterializingTimelineEntry(threadId: string) {
    markCompletedAgentTurnSeen(threadId);
    setTimeline(createTimelineState());
    setTimelineEntry({ phase: "streamingLive", threadId });
  }

  async function handleCreateProject(options: { createDirectory?: boolean } = {}) {
    const cwd = projectCwd.trim();
    if (!cwd) {
      return;
    }

    try {
      const project = await createProjectMutation.mutateAsync({
        ...(options.createDirectory ? { createDirectory: true } : {}),
        cwd,
      });
      queryClientForShell.setQueryData<Project[]>(queryKeys.projects, (current) => [project, ...(current ?? [])]);
      selectProject(project.id);
      setProjectCwd("");
      setProjectDirectoryCreateCwd(null);
      setProjectFormOpen(false);
    } catch (error) {
      if (!options.createDirectory && errorMessageFrom(error) === "directory does not exist") {
        setProjectDirectoryCreateCwd(cwd);
        return;
      }
      reportError(error);
    }
  }

  function handleProjectCwdChange(value: string) {
    setProjectCwd(value);
    setProjectDirectoryCreateCwd(null);
  }

  function handleReorderProjects(nextProjectIds: string[]) {
    setProjectOrderIds(nextProjectIds);
    saveSidebarProjectOrder(nextProjectIds);
  }

  async function createDraftThreadFromComposer({
    composerSettings: paneComposerSettings,
    firstMessageText,
    projectId,
  }: {
    composerSettings?: ComposerSettings;
    firstMessageText: string;
    projectId?: string;
  }) {
    draftComposerTransitionOriginRef.current = composerShellRef.current?.getBoundingClientRect() ?? null;
    const threadSettings =
      paneComposerSettings ??
      (projectId || draftComposerEditedRef.current
        ? composerSettings
        : (await hydrateComposerDefaults(null)) ?? composerSettings);
    const thread = optimisticThreadSummary(
      projectId
        ? await createThread(projectId, createThreadOptions(threadSettings))
        : await createChatThread(firstMessageText, createThreadOptions(threadSettings)),
      firstMessageText,
    );
    if (projectId) {
      upsertProjectThread(queryClientForShell, projectId, thread);
    } else {
      upsertChatThread(queryClientForShell, thread);
    }
    activeDraftComposerThreadIdRef.current = thread.id;
    setPendingTitleThreadIds((current) => markThreadTitlePending(current, thread));
    setMaterializingThreadIds((current) => {
      const next = new Set(current);
      next.add(thread.id);
      return next;
    });
    setIsDraftComposerTransitioning(draftComposerTransitionOriginRef.current !== null);
    selectMaterializedThread({ projectId: projectId ?? null, thread });
    setDraftComposerTransitionToken((current) => current + 1);
    return { threadId: thread.id, composerSettings: threadSettings };
  }

  function markThreadMaterialized(threadId: string) {
    if (activeDraftComposerThreadIdRef.current === threadId) {
      activeDraftComposerPaneIdRef.current = null;
      activeDraftComposerThreadIdRef.current = null;
    }
    setMaterializingThreadIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
  }

  function markThreadActive(threadId: string) {
    patchThreadEverywhere(threadId, (thread) =>
      thread.status === "active" ? thread : { ...thread, status: "active" },
    );
  }

  function markThreadIdle(threadId: string) {
    patchThreadEverywhere(threadId, (thread) =>
      thread.status === "idle" ? thread : { ...thread, status: "idle" },
    );
  }

  async function handleArchiveThread(threadId = selectedThreadIdRef.current) {
    if (!threadId) {
      return;
    }
    const archivedSelectedThreadId = selectedThreadIdRef.current;
    const shouldSelectDraftAfterArchive = threadId === archivedSelectedThreadId;
    const draftProjectId = selectedProjectIdRef.current;
    await archiveThreadMutation.mutateAsync(threadId);
    attachingThreadIdsRef.current.delete(threadId);
    removeThreadEverywhere(queryClientForShell, threadId);
    if (
      shouldSelectDraftAfterArchive &&
      (selectedThreadIdRef.current === archivedSelectedThreadId || selectedThreadIdRef.current === null)
    ) {
      clearSelectionToDraft({ projectId: draftProjectId, replaceRoute: true });
    }
  }

  async function handleCreateAutomation(request: AutomationCreateRequest) {
    return createAutomationMutation.mutateAsync(request);
  }

  async function handleUpdateAutomation(automationId: string, request: AutomationUpdateRequest) {
    return updateAutomationMutation.mutateAsync({ automationId, request });
  }

  async function handlePauseAutomation(automationId: string) {
    return pauseAutomationMutation.mutateAsync(automationId);
  }

  async function handleResumeAutomation(automationId: string) {
    return resumeAutomationMutation.mutateAsync(automationId);
  }

  async function handleDeleteAutomation(automationId: string) {
    await deleteAutomationMutation.mutateAsync(automationId);
  }

  function handleSelectedThreadSnapshot(thread: ThreadSummary) {
    if (thread.id === selectedThreadIdRef.current) {
      setRouteSelectedThreadState(thread);
      setUnavailableThreadId((current) => (current === thread.id ? null : current));
    }
    replaceThread(thread);
    markCompletedAgentTurnSeen(thread.id, thread.lastCompletedAgentTurnSeq);
  }

  function handleSelectedThreadLoadFailed(threadId: string) {
    if (threadId !== selectedThreadIdRef.current) {
      return;
    }
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(threadId);
  }

  async function handlePinThread(threadId: string) {
    try {
      const pinnedAt = await pinThreadMutation.mutateAsync(threadId);
      applyThreadPinState(threadId, pinnedAt);
    } catch (error) {
      reportError(error);
    }
  }

  async function handleUnpinThread(threadId: string) {
    try {
      const pinnedAt = await unpinThreadMutation.mutateAsync(threadId);
      applyThreadPinState(threadId, pinnedAt);
    } catch (error) {
      reportError(error);
    }
  }

  async function handleRenameThread(threadId: string, name: string) {
    await renameThreadMutation.mutateAsync({ threadId, name });
  }

  async function handleSetThreadNotificationsEnabled(threadId: string, enabled: boolean) {
    try {
      const update = await threadNotificationsMutation.mutateAsync({ threadId, enabled });
      applyThreadNotificationsState(update.threadId, update.notificationsEnabled);
    } catch (error) {
      reportError(error);
    }
  }

  function applySubagentDiscoveryEvent(event: ThreadSubagentDiscoveryEvent) {
    const key = queryKeys.threadSubagents(event.parentThreadId);
    if (event.kind === "refresh") {
      void queryClientForShell.invalidateQueries({ queryKey: key });
      return;
    }
    let hadCachedList = false;
    queryClientForShell.setQueryData(key, (current: unknown) => {
      if (!Array.isArray(current)) {
        return current;
      }
      hadCachedList = true;
      if (event.kind === "delete") {
        return current.filter((subagent) => subagent?.id !== event.subagentId);
      }
      const next = [...current];
      const existingIndex = next.findIndex((subagent) => subagent?.id === event.subagent.id);
      if (existingIndex >= 0) {
        next[existingIndex] = event.subagent;
        return next;
      }
      next.push(event.subagent);
      return next;
    });
    if (!hadCachedList && selectedThreadIdRef.current === event.parentThreadId) {
      void queryClientForShell.invalidateQueries({ queryKey: key });
    }
  }

  function reportError(error: unknown, context?: string) {
    const message = errorMessageFrom(error);
    setErrorMessage(context ? `${context}: ${message}` : message);
  }

  function upsertQueuedInput(row: QueuedInput) {
    upsertCachedQueuedInput(queryClientForShell, row);
  }

  function removeQueuedInput(threadId: string, id: string) {
    deleteCachedQueuedInput(queryClientForShell, threadId, id);
  }

  function resetComposerDraft() {
    setComposerResetToken((current) => current + 1);
  }

  const handleArchiveThreadById = useEventCallback((threadId: string) => void handleArchiveThread(threadId));
  const handleCloseLightbox = useEventCallback(() => setLightboxImage(null));
  const handleCloseMarkdownPreview = useEventCallback(() => setMarkdownPreview(null));
  const handleOpenMarkdownPreview = useEventCallback((request: MarkdownPreviewRequest) => setMarkdownPreview(request));
  const handleThreadPaneSnapshotLoaded = useEventCallback((thread: ThreadSummary) => {
    setThreadPaneSnapshotReadyIds((current) => {
      if (current.has(thread.id)) {
        return current;
      }
      const next = new Set(current);
      next.add(thread.id);
      return next;
    });
    if (thread.id === selectedThreadIdRef.current) {
      setRouteSelectedThreadState(thread);
      setUnavailableThreadId((current) => (current === thread.id ? null : current));
    }
    replaceThread(thread);
  });
  const handleThreadPaneSnapshotLoadFailed = useEventCallback((threadId: string) => {
    setThreadPaneSnapshotReadyIds((current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(threadId);
      return next;
    });
    handleSelectedThreadLoadFailed(threadId);
  });
  const handleClosePreferences = useEventCallback(() => setPreferencesOpen(false));
  const handleOpenPreferences = useEventCallback(() => setPreferencesOpen(true));
  const stableHandleCreateProject = useEventCallback(handleCreateProject);
  const stableHandleCreateChat = useEventCallback(handleCreateChat);
  const stableHandleCreateThread = useEventCallback(handleCreateThread);
  const stableHandlePinThread = useEventCallback((threadId: string) => void handlePinThread(threadId));
  const stableHandleRenameThread = useEventCallback((threadId: string, name: string) =>
    handleRenameThread(threadId, name),
  );
  const stableHandleSetThreadNotificationsEnabled = useEventCallback((threadId: string, enabled: boolean) =>
    void handleSetThreadNotificationsEnabled(threadId, enabled),
  );
  const stableHandleSelectAutomations = useEventCallback(handleSelectAutomations);
  const stableHandleSelectProjectSettings = useEventCallback(handleSelectProjectSettings);
  const stableHandleSelectChatThread = useEventCallback(handleSelectChatThread);
  const stableHandleSelectPinnedThread = useEventCallback(handleSelectPinnedThread);
  const stableHandleSelectThread = useEventCallback(handleSelectThread);
  const stableHandleUnpinThread = useEventCallback((threadId: string) => void handleUnpinThread(threadId));
  const workspaceThreadActions = useMemo(
    () => ({
      onArchiveThread: handleArchiveThreadById,
      onPinThread: stableHandlePinThread,
      onRenameThread: stableHandleRenameThread,
      onSetThreadNotificationsEnabled: stableHandleSetThreadNotificationsEnabled,
      onUnpinThread: stableHandleUnpinThread,
    }),
    [
      handleArchiveThreadById,
      stableHandlePinThread,
      stableHandleRenameThread,
      stableHandleSetThreadNotificationsEnabled,
      stableHandleUnpinThread,
    ],
  );
  const handleShowMobileSidebar = useEventCallback(() => {
    pushKodexRoute({
      panel: "threads",
      projectId: selectedMainPane === "project" ? selectedProjectPaneId : null,
      threadId: null,
      view: selectedMainPane,
    });
    setMobilePanel("threads");
  });
  const handleShowMobileThread = useEventCallback(() => {
    pushKodexRoute({
      panel: null,
      projectId: selectedMainPane === "project" ? selectedProjectPaneId : null,
      threadId: null,
      view: selectedMainPane,
    });
    setMobilePanel("chat");
  });
  const handleLoadMoreChatThreads = useEventCallback(async () => {
    const cursor = chatThreadsNextCursor;
    if (!cursor || chatThreadsLoadingCursorRef.current === cursor) {
      return;
    }
    chatThreadsLoadingCursorRef.current = cursor;
    setChatThreadsPaginationState("loading");
    try {
      const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads);
      const response = await listChatThreadsPage({ cursor });
      queryClientForShell.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
        mergeChatThreadData(current, response.threads, beforeSnapshot),
      );
      setChatThreadsNextCursor(response.nextCursor ?? null);
      setChatThreadsPaginationState("idle");
    } catch (error) {
      setChatThreadsPaginationState("error");
      reportError(error);
    } finally {
      if (chatThreadsLoadingCursorRef.current === cursor) {
        chatThreadsLoadingCursorRef.current = null;
      }
    }
  });
  const handleLoadMoreProjectThreads = useEventCallback(async (projectId: string) => {
    const cursor = projectThreadNextCursors[projectId];
    if (!cursor || projectThreadLoadingCursorsRef.current[projectId] === cursor) {
      return;
    }
    projectThreadLoadingCursorsRef.current = { ...projectThreadLoadingCursorsRef.current, [projectId]: cursor };
    setProjectThreadPaginationStateById((current) => ({ ...current, [projectId]: "loading" }));
    try {
      const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId));
      const response = await listThreadsPage(projectId, { cursor });
      mergeProjectThreadSnapshot(
        queryClientForShell,
        projectId,
        response.threads,
        routeSelectedThreadRef.current,
        selectedThreadIdRef.current,
        beforeSnapshot,
      );
      setProjectThreadNextCursors((current) => ({ ...current, [projectId]: response.nextCursor ?? null }));
      setProjectThreadPaginationStateById((current) => ({ ...current, [projectId]: "idle" }));
    } catch (error) {
      setProjectThreadPaginationStateById((current) => ({ ...current, [projectId]: "error" }));
      reportError(error);
    } finally {
      if (projectThreadLoadingCursorsRef.current[projectId] === cursor) {
        const { [projectId]: _finishedCursor, ...remaining } = projectThreadLoadingCursorsRef.current;
        projectThreadLoadingCursorsRef.current = remaining;
      }
    }
  });
  const pinnedStateIsTrusted = pinnedStateTrusted;
  const sidebarPinnedThreads = pinnedStateIsTrusted ? pinnedThreads : [];
  const sidebarChatThreads = useMemo(
    () => (pinnedStateIsTrusted ? withoutPinnedThreads(chatThreads) : chatThreads),
    [chatThreads, pinnedStateIsTrusted],
  );
  const sidebarThreadsByProjectId = useMemo(
    () => withPinnedProjectThreads(threadsByProjectId, sidebarPinnedThreads, orderedProjects),
    [orderedProjects, sidebarPinnedThreads, threadsByProjectId],
  );
  const sidebarDataState = useMemo(
    () => ({
      chatThreads: scopedSidebarQueriesEnabled ? queryResultLoadState(chatThreadsQuery) : queryResultLoadState(sidebarThreadsQuery),
      pinnedThreads: pinnedStateIsTrusted && scopedSidebarQueriesEnabled ? queryResultLoadState(pinnedThreadsQuery) : "loading",
      projects: scopedSidebarQueriesEnabled ? queryResultLoadState(projectsQuery) : queryResultLoadState(sidebarThreadsQuery),
      projectThreadsById: Object.fromEntries(
        orderedProjects.map((project, index) => [
          project.id,
          scopedSidebarQueriesEnabled ? queryResultLoadState(projectThreadQueries[index]) : queryResultLoadState(sidebarThreadsQuery),
        ]),
      ),
    }),
    [
      chatThreadsQuery,
      orderedProjects,
      pinnedStateIsTrusted,
      pinnedThreadsQuery,
      projectThreadQueries,
      projectsQuery,
      scopedSidebarQueriesEnabled,
      sidebarThreadsQuery,
    ],
  );
  const selectedSubagentStillAvailable =
    selectedSubagentThreadId !== null &&
    selectedThreadSubagents.some((subagent) => subagent.id === selectedSubagentThreadId);
  const subagentViewer =
    subagentSidebarOpen && selectedSubagentStillAvailable ? (
      <Suspense fallback={null}>
        <SubagentThreadViewer
          imagePreviewUrlsByPath={mergedImagePreviewUrlsByPath}
          onError={reportError}
          onImageOpen={setLightboxImage}
          onMarkdownOpen={setMarkdownPreview}
          onSelectSubagent={setSelectedSubagentThreadId}
          selectedSubagentId={selectedSubagentThreadId}
          showDebugEvents={showDebugEvents}
          subagents={selectedThreadSubagents}
        />
      </Suspense>
    ) : null;
  const gatewayTerminalAvailable = capabilitiesQuery.data?.gateway.terminals?.enabled ?? true;
  const handlePaneImagePreviewUrlsChanged = useEventCallback((previewUrls: Record<string, string>) => {
    if (Object.keys(previewUrls).length === 0) {
      return;
    }
    setPaneImagePreviewUrlsByPath((current) => {
      let changed = false;
      const next = { ...current };
      for (const [path, url] of Object.entries(previewUrls)) {
        if (next[path] !== url) {
          next[path] = url;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  });
  const handleWorkspaceFocusThreadPane = useEventCallback((threadId: string) => {
    if (selectedMainPane !== "thread") {
      return;
    }
    handleFocusWorkspaceThreadPane(threadId);
  });
  const handlePaneComposerSettingsChange = useEventCallback((paneId: string, settings: ComposerSettings) => {
    setPaneComposerSettingsByPaneId((current) => {
      const existing = current[paneId];
      if (existing && sameComposerSettings(existing, settings)) {
        return current;
      }
      return {
        ...current,
        [paneId]: settings,
      };
    });
  });
  const renderWorkspaceThreadComposer = useCallback(
    (pane: WorkspacePane, paneState: ThreadComposerState) => (
      <ThreadPaneComposerBridge
        composerDefaults={composerSettings}
        contextUsageByThreadId={contextUsageByThreadId}
        composerDraftStore={composerDraftStoreRef.current}
        composerSettingsError={composerSettingsError}
        hydrateComposerDefaults={hydrateComposerDefaults}
        isDraftComposerTransitioning={isDraftComposerTransitioning}
        models={models}
        onCreateDraftThread={createDraftThreadFromComposer}
        onError={reportError}
        onImageOpen={setLightboxImage}
        onImagePreviewUrlsChanged={handlePaneImagePreviewUrlsChanged}
        onQueuedInputDeleted={removeQueuedInput}
        onQueuedInputUpsert={upsertQueuedInput}
        onPaneComposerSettingsChange={handlePaneComposerSettingsChange}
        onThreadMaterialized={markThreadMaterialized}
        onThreadTurnStartFailed={markThreadIdle}
        onThreadTurnStarted={markThreadActive}
        paneComposerSettingsByPaneId={paneComposerSettingsByPaneId}
        pane={pane}
        paneState={paneState}
        projects={orderedProjects}
        skillsInvalidationGeneration={skillsInvalidationGeneration}
        threadComposerDefaults={workspaceComposerDefaults}
      />
    ),
    [
      composerSettingsError,
      composerSettings,
      contextUsageByThreadId,
      createDraftThreadFromComposer,
      handlePaneImagePreviewUrlsChanged,
      handlePaneComposerSettingsChange,
      hydrateComposerDefaults,
      isDraftComposerTransitioning,
      markThreadActive,
      markThreadIdle,
      markThreadMaterialized,
      models,
      orderedProjects,
      paneComposerSettingsByPaneId,
      removeQueuedInput,
      reportError,
      skillsInvalidationGeneration,
      upsertQueuedInput,
      workspaceComposerDefaults,
    ],
  );
  const renderWorkspaceThreadPaneAside = useCallback<
    NonNullable<ComponentProps<typeof WorkspaceProvider>["renderThreadPaneAside"]>
  >(
    (_pane, state) => (state.isActive && state.thread.id === selectedThreadId ? subagentViewer : null),
    [selectedThreadId, subagentViewer],
  );
  const renderWorkspaceThreadPaneHeaderActions = useCallback<
    NonNullable<ComponentProps<typeof WorkspaceProvider>["renderThreadPaneHeaderActions"]>
  >(
    (_pane, state) =>
      state.isActive && state.thread.id === selectedThreadId && selectedThreadSubagents.length > 0 ? (
        <AdaptiveIconButton
          aria-pressed={subagentSidebarOpen ? "true" : "false"}
          label={subagentSidebarOpen ? "Hide subagents" : "Show subagents"}
          onClick={() => setSubagentSidebarOpen((current) => !current)}
          variant={subagentSidebarOpen ? "light" : "subtle"}
        >
          <Bot />
        </AdaptiveIconButton>
      ) : null,
    [selectedThreadId, selectedThreadSubagents.length, subagentSidebarOpen],
  );
  return (
    <>
      <WorkspaceProvider
        approvals={approvals}
        errorMessage={errorMessage}
        imagePreviewUrlsByPath={mergedImagePreviewUrlsByPath}
        onApprovalDecision={handleApprovalDecision}
        onFocusThreadPane={handleWorkspaceFocusThreadPane}
        onImageOpen={setLightboxImage}
        onLiveEvent={handleWorkspaceLiveEvent}
        onMarkdownOpen={handleOpenMarkdownPreview}
        onShowMobileSidebar={handleShowMobileSidebar}
        onThreadSnapshotLoadFailed={handleThreadPaneSnapshotLoadFailed}
        onThreadSnapshotLoaded={handleThreadPaneSnapshotLoaded}
        onVisibleThreadIdsChange={handleVisibleThreadIdsChange}
        paneStore={workspacePaneStore}
        publishThreadPaneTimelineAction={publishThreadPaneTimelineAction}
        renderThreadComposer={renderWorkspaceThreadComposer}
        renderThreadPaneAside={renderWorkspaceThreadPaneAside}
        renderThreadPaneHeaderActions={renderWorkspaceThreadPaneHeaderActions}
        showDebugEvents={showDebugEvents}
        subscribeThreadPaneTimelineAction={subscribeThreadPaneTimelineAction}
        threadActions={workspaceThreadActions}
        threadProjectIdsById={threadProjectIdsById}
        threadSummariesById={threadSummariesById}
      >
        <KodexShellView
          automationsPaneProps={{
          automations,
          defaultThreadId: selectedThreadId,
          isLoading: automationsQuery.isLoading,
          onCreateAutomation: handleCreateAutomation,
          onDeleteAutomation: handleDeleteAutomation,
          onPauseAutomation: handlePauseAutomation,
          onResumeAutomation: handleResumeAutomation,
          onShowMobileSidebar: handleShowMobileSidebar,
          onUpdateAutomation: handleUpdateAutomation,
          threadOptions: automationTargetThreadOptions,
        }}
        isDraftThreadSelected={isDraftThreadSelected}
        isSidebarResizing={isSidebarResizing}
        mainPane={selectedMainPane}
        mobilePanel={mobilePanel}
        preferencesProps={{
          activeSection: preferencesSection, colorSchemeId, onClose: handleClosePreferences, onColorSchemeChange,
          onSectionChange: setPreferencesSection, opened: preferencesOpen,
        }}
        projectPaneProps={{
          onShowMobileSidebar: handleShowMobileSidebar,
          project: selectedProjectPane,
        }}
          sidebarCollapsed={sidebarCollapsed}
          useSingleThreadWorkspace={useSingleThreadWorkspace}
          workspaceSidebarProps={{
          account, approvals, chatThreads: sidebarChatThreads, dataState: sidebarDataState, hoveredThreadActionId,
          chatThreadsHasMore: chatThreadsNextCursor !== null,
          chatThreadsPaginationState,
          onArchiveThread: handleArchiveThreadById,
          onCreateChat: stableHandleCreateChat, onCreateProject: stableHandleCreateProject, onCreateThread: stableHandleCreateThread, onLogout: handleLogout,
          onLoadMoreChatThreads: handleLoadMoreChatThreads, onLoadMoreProjectThreads: handleLoadMoreProjectThreads,
          onPinThread: stableHandlePinThread,
          onOpenPreferences: handleOpenPreferences, onOpenTerminal: gatewayTerminalAvailable ? () => undefined : undefined, onProjectCwdChange: handleProjectCwdChange, onProjectDirectoryCreateCancel: () => setProjectDirectoryCreateCwd(null),
          onProjectFormOpenChange: setProjectFormOpen, onReorderProjects: handleReorderProjects, onSelectChatThread: stableHandleSelectChatThread,
          onSelectAutomations: stableHandleSelectAutomations, onSelectPinnedThread: stableHandleSelectPinnedThread, onSelectProjectSettings: stableHandleSelectProjectSettings, onSelectThread: stableHandleSelectThread, onUnpinThread: stableHandleUnpinThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onSidebarCollapseClick: handleSidebarCollapseClick,
          onSidebarExpandClick: handleSidebarExpandClick, onThreadActionHoverChange: setHoveredThreadActionId,
          pinnedThreads: sidebarPinnedThreads,
          pendingTitleThreadIds, projectCwd, projectDirectoryCreatePending: projectDirectoryCreateCwd === projectCwd.trim() && projectCwd.trim().length > 0,
          projectThreadHasMoreById: Object.fromEntries(Object.entries(projectThreadNextCursors).map(([projectId, cursor]) => [projectId, cursor !== null])),
          projectThreadPaginationStateById,
          projectFormOpen, projects: orderedProjects, selectedMainPane, selectedProjectId, selectedThreadId: selectedMainPane === "thread" ? selectedThreadId : null,
          showDebugEvents, sidebarWidth, threadsByProjectId: sidebarThreadsByProjectId, usageLimitLines,
        }}
        workspaceSelectedThreadPaneId={
          selectedMainPane === "thread" && !isSelectedThreadSnapshotDeferred ? routeThreadPaneId ?? unavailableThreadId : null
        }
        />
      </WorkspaceProvider>
      {lightboxImage ? (
        <Suspense fallback={null}>
          <ImageLightbox image={lightboxImage} onClose={handleCloseLightbox} />
        </Suspense>
      ) : null}
      {markdownPreview ? (
        <Suspense fallback={null}>
          <MarkdownPreviewPane preview={markdownPreview} threadId={selectedThreadId ?? undefined} onClose={handleCloseMarkdownPreview} />
        </Suspense>
      ) : null}
    </>
  );
}
