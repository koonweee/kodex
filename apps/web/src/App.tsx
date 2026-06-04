import { MantineProvider } from "@mantine/core";
import { QueryClientProvider, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  getThreadGeneratedUi,
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
  submitGeneratedUiSession,
  unpinThread,
  updateAutomation,
  type Approval,
  type Automation,
  type AutomationCreateRequest,
  type AutomationUpdateRequest,
  type EventEnvelope,
  type GeneratedUiSubmitRequest,
  type GeneratedUiSubmitResponse,
  type Project,
  type QueuedInput,
  type ThreadSummary,
  type TimelineSkillMention,
} from "./api/client";
import { queryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import {
  deleteCachedAutomation,
  mergeAutomationData,
  upsertCachedAutomation,
} from "./automations/cache";
import { automationThreadOptions } from "./automations/threadOptions";
import { createThreadOptions } from "./composer/settings";
import { useComposerSettingsState } from "./composer/useComposerSettingsState";
import { useComposerOrchestration } from "./composer/useComposerOrchestration";
import { installLiveLongTaskObserver } from "./events/liveDiagnostics";
import { useLiveEventHandlers } from "./events/useLiveEventHandlers";
import { useGlobalLiveStream } from "./events/useGlobalLiveStream";
import type { MarkdownPreviewRequest } from "./files/types";
import { GeneratedUiPane } from "./generatedUi/GeneratedUiPane";
import type { ImageLightboxImage } from "./images/types";
import { useKodexNotifications } from "./notifications/useKodexNotifications";
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
  threadDisplayTitle,
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
import {
  addOptimisticUserMessage,
  createTimelineState,
  markOptimisticUserMessageSent,
  removeOptimisticUserMessage,
  type TimelineState,
} from "./timeline/reducer";
import { errorMessageFrom } from "./shared/values";
import { createClientRequestId } from "./shared/id";
import { KodexShellView } from "./shell/KodexShellView";
import {
  currentKodexRoute,
  pushKodexRoute,
} from "./shell/browserRouting";
import { queryResultLoadState } from "./shell/queryResultLoadState";
import { useSidebarResize } from "./shell/useSidebarResize";
import { useShellSelection } from "./shell/useShellSelection";
import "./App.css";

const NEW_THREAD_TITLE = "New thread";
const DRAFT_COMPOSER_TRANSITION_MS = 280;
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

export function App() {
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
    <QueryClientProvider client={queryClient}>
      <MantineProvider forceColorScheme={colorScheme.mode} theme={theme}>
        {isThemeWorkbench ? (
          <Suspense fallback={null}>
            <ThemeWorkbench colorSchemeId={colorSchemeId} onColorSchemeChange={setColorSchemeId} />
          </Suspense>
        ) : (
          <KodexShell colorSchemeId={colorSchemeId} onColorSchemeChange={setColorSchemeId} />
        )}
      </MantineProvider>
    </QueryClientProvider>
  );
}

function KodexShell({
  colorSchemeId,
  onColorSchemeChange,
}: {
  colorSchemeId: KodexColorSchemeId;
  onColorSchemeChange: (colorSchemeId: KodexColorSchemeId) => void;
}) {
  const [initialRoute] = useState(() => currentKodexRoute());
  const queryClientForShell = useQueryClient();
  const [projectOrderIds, setProjectOrderIds] = useState<string[] | null>(() => loadSidebarProjectOrder());
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [timelineEntry, setTimelineEntry] = useState<TimelineEntry>(() =>
    initialRoute.threadId ? { phase: "loadingSnapshot", threadId: initialRoute.threadId } : idleTimelineEntry,
  );
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectCwd, setProjectCwd] = useState("");
  const [projectDirectoryCreateCwd, setProjectDirectoryCreateCwd] = useState<string | null>(null);
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [threadSyncNotice, setThreadSyncNotice] = useState<ThreadSyncNotice | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewRequest | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferenceSection>("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const [subagentSidebarOpen, setSubagentSidebarOpen] = useState(false);
  const [selectedSubagentThreadId, setSelectedSubagentThreadId] = useState<string | null>(null);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [hiddenGeneratedUiKey, setHiddenGeneratedUiKey] = useState<string | null>(null);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const globalEventCursorRef = useRef<number | undefined>(undefined);
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
  const draftComposerTransitionOriginRef = useRef<DOMRect | null>(null);
  const liveUsageLimitSnapshotReceivedRef = useRef(false);
  const [draftComposerTransitionToken, setDraftComposerTransitionToken] = useState(0);
  const [isDraftComposerTransitioning, setIsDraftComposerTransitioning] = useState(false);
  const [pinnedStateTrusted, setPinnedStateTrusted] = useState(false);
  const [chatThreadsNextCursor, setChatThreadsNextCursor] = useState<string | null>(null);
  const [projectThreadNextCursors, setProjectThreadNextCursors] = useState<Record<string, string | null>>({});
  const [chatThreadsPaginationState, setChatThreadsPaginationState] = useState<SidebarPaginationState>("idle");
  const [projectThreadPaginationStateById, setProjectThreadPaginationStateById] = useState<Record<string, SidebarPaginationState>>({});

  const {
    clearSelectionToDraft,
    draftChatThreadSelected,
    draftThreadProjectId,
    handleCreateChat,
    handleCreateThread,
    handleDraftProjectChange,
    handleSelectAutomations,
    handleSelectChatThread,
    handleSelectPinnedThread,
    handleSelectProjectSettings,
    handleSelectThread,
    mobilePanel,
    routeSelectedThread,
    routeSelectedThreadRef,
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
  const projects = projectsQuery.data ?? [];
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
      next[project.id] = projectThreadQueries[index]?.data ?? [];
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
  const selectedQueuedInputsThreadId = selectedThreadId;
  const selectedQueuedInputsQuery = useQuery({
    enabled: selectedQueuedInputsThreadId !== null,
    queryKey: selectedQueuedInputsThreadId ? queryKeys.queuedInputs(selectedQueuedInputsThreadId) : ["queued-inputs", "none"],
    queryFn: async () => {
      const threadId = selectedQueuedInputsThreadId;
      if (!threadId) {
        return [];
      }
      const snapshot = await listQueuedInputs(threadId);
      return mergeQueuedInputData(
        queryClientForShell.getQueryData<QueuedInput[]>(queryKeys.queuedInputs(threadId)),
        snapshot,
        queryClientForShell.getQueryData<string[]>(queryKeys.queuedInputTombstones(threadId)) ?? [],
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
  const submitGeneratedUiMutation = useMutation({
    mutationFn: ({
      request,
      sessionId,
    }: {
      request: GeneratedUiSubmitRequest;
      sessionId: string;
    }) => submitGeneratedUiSession(sessionId, request),
    onSuccess: (response) => {
      queryClientForShell.setQueryData(queryKeys.generatedUi(response.session.threadId), response.session);
    },
  });
  const chatThreads = chatThreadsQuery.data ?? [];
  const pinnedThreads = pinnedThreadsQuery.data ?? [];
  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? [] : [];
  const flatProjectThreads = useMemo(() => Object.values(threadsByProjectId).flat(), [threadsByProjectId]);
  const selectedProject = selectedProjectId ? orderedProjects.find((project) => project.id === selectedProjectId) ?? null : null;
  const selectedProjectPane =
    selectedProjectPaneId ? orderedProjects.find((project) => project.id === selectedProjectPaneId) ?? null : null;
  const selectedThread =
    (routeSelectedThread?.id === selectedThreadId ? routeSelectedThread : null) ??
    selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    flatProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    chatThreads.find((thread) => thread.id === selectedThreadId) ??
    pinnedThreads.find((thread) => thread.id === selectedThreadId) ??
    null;
  const selectedTimelineEntry =
    selectedThreadId !== null && timelineEntry.threadId === selectedThreadId ? timelineEntry : idleTimelineEntry;
  const isSelectedThreadSnapshotDeferred =
    selectedThreadId !== null && materializingThreadIds.has(selectedThreadId);
  const isSelectedTimelineLoading = selectedTimelineEntry.phase === "loadingSnapshot";
  const isSelectedTimelineReady =
    selectedTimelineEntry.phase === "streamingLive" || selectedTimelineEntry.phase === "refreshingSnapshot";
  const isDraftThreadSelected =
    draftChatThreadSelected || (draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId);
  const selectedGeneratedUiThreadId =
    selectedMainPane === "thread" && selectedThreadId && !isDraftThreadSelected ? selectedThreadId : null;
  const selectedGeneratedUiQuery = useQuery({
    enabled: selectedGeneratedUiThreadId !== null,
    queryKey: selectedGeneratedUiThreadId ? queryKeys.generatedUi(selectedGeneratedUiThreadId) : ["threads", "none", "generated-ui"],
    queryFn: async () => {
      const threadId = selectedGeneratedUiThreadId;
      return threadId ? getThreadGeneratedUi(threadId) : null;
    },
  });
  const selectedThreadSubagentsQuery = useQuery({
    enabled: selectedMainPane === "thread" && selectedThread !== null && isSelectedTimelineReady,
    queryKey: selectedThread ? queryKeys.threadSubagents(selectedThread.id) : ["threads", "none", "subagents"],
    queryFn: async () => {
      const threadId = selectedThread?.id;
      return threadId ? listThreadSubagents(threadId) : [];
    },
  });
  const selectedThreadSubagents = selectedThreadSubagentsQuery.data ?? [];
  const selectedQueuedInputs = selectedThreadId ? selectedQueuedInputsQuery.data ?? [] : [];
  const automations = automationsQuery.data ?? [];
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
    applyApprovalEventsWithTombstone,
    handleApprovalDecision,
    selectedThreadApprovals,
    setApprovals,
  } = useApprovalsState({ selectedThreadId });
  approvalsRef.current = approvals;
  chatThreadsRef.current = chatThreads;
  pinnedThreadsRef.current = pinnedThreads;
  pendingTitleThreadIdsRef.current = pendingTitleThreadIds;
  threadsByProjectIdRef.current = threadsByProjectId;
  const {
    account,
    handleCancelLogin,
    handleLogin,
    handleLogout,
    loginState,
  } = useAccountSession({ onError: reportError });
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
    handleComposerSettingsChange,
    hydrateComposerDefaults,
    models,
    selectedThreadComposerOverride,
  } = useComposerSettingsState({
    draftChatThreadSelected,
    onError: reportError,
    onThreadUpdated: replaceThread,
    selectedProjectId,
    selectedThread,
  });
  composerDefaultsRef.current = { draftComposerEditedRef, hydrateComposerDefaults };
  const { applyCompletedAgentTurnEvent, applyThreadReadStateEvent, markCompletedAgentTurnSeen } = useThreadReadState({
    chatThreads,
    onError: reportError,
    selectedThreadIdRef,
    threadsByProjectId,
    pinnedThreads,
    updateThreadEverywhere: patchThreadEverywhere,
  });
  useThreadViewPresence({
    enabled: selectedMainPane === "thread",
    threadId: selectedThreadId,
  });
  useKodexNotifications({
    chatThreads,
    pinnedThreads,
    routeSelectedThread,
    threadsByProjectId,
  });
  const {
    applyThreadMetadataEvent,
    applyThreadMetadataEvents,
    selectedContextUsage,
  } = useThreadMetadata({
    selectedThreadId,
    setPendingTitleThreadIds,
    updateThreadEverywhere: patchThreadEverywhere,
  });
  const {
    handleSidebarResizeKeyDown,
    handleSidebarResizePointerDown,
    isSidebarResizing,
    sidebarWidth,
  } = useSidebarResize();
  const activeSelectedTurnId = selectedThread !== null ? timeline.activeTurnId : null;
  const composerDraftKey =
    selectedThreadId ??
    (draftChatThreadSelected
      ? "draft:chat"
      : draftThreadProjectId
        ? `draft:project:${draftThreadProjectId}`
        : "draft:none");
  const draftComposerProject = draftThreadProjectId
    ? orderedProjects.find((project) => project.id === draftThreadProjectId) ?? null
    : null;
  const composerCwd =
    selectedThread?.cwd ??
    (isDraftThreadSelected && !draftChatThreadSelected
      ? draftComposerProject?.cwd ?? selectedProject?.cwd ?? null
      : null);
  const canCompose = selectedThread !== null || isSelectedTimelineLoading || isDraftThreadSelected;
  const {
    attachmentInputRef,
    handleAbortQueuedSteer,
    handleAttachmentInputChange,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerKeyDown,
    handleComposerPaste,
    handleStopTurn,
    handleSubmitQueuedSteer,
    handleSubmitTurn,
    imagePreviewUrlsByPath,
    isComposerDragActive,
    isComposerSubmitting,
    isQueuedTurnStartPending,
    pendingAttachments,
    queuedSteerRows,
    removePendingAttachment,
  } = useComposerOrchestration({
    activeSelectedTurnId,
    canCompose,
    composerSettings,
    selectedThreadComposerOverride,
    draftChatThreadSelected,
    draftThreadProjectId,
    isDraftThreadSelected,
    onCreateDraftThread: createDraftThreadFromComposer,
    onError: reportError,
    onOptimisticUserMessageRemoved: removeOptimisticTimelineUserMessage,
    onOptimisticUserMessageSent: markOptimisticTimelineUserMessageSent,
    onOptimisticUserMessageStarted: addOptimisticTimelineUserMessage,
    onQueuedInputDeleted: removeQueuedInput,
    onQueuedInputUpsert: upsertQueuedInput,
    onThreadMaterialized: markThreadMaterialized,
    onThreadTurnStartFailed: markThreadIdle,
    onThreadTurnStarted: markThreadActive,
    queuedSteerRows: selectedQueuedInputs,
    selectedProjectId,
    selectedThreadId,
  });
  const selectedThreadTitle = selectedThread
    ? pendingTitleThreadIds.has(selectedThread.id)
      ? NEW_THREAD_TITLE
      : threadDisplayTitle(selectedThread)
    : NEW_THREAD_TITLE;
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
      setSubagentSidebarOpen(false);
      setSelectedSubagentThreadId(null);
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

  useGlobalLiveStream({
    cursorRef: globalEventCursorRef,
    handlers: liveRouteHandlers,
    selectedThreadId,
    selectedThreadIdRef,
  });

  useSelectedThreadAttach({
    attachingThreadIdsRef,
    isSelectedThreadSnapshotDeferred,
    onAttachedThread: replaceThread,
    onError: reportError,
    selectedThread,
  });

  const { loadOlderHistory } = useSelectedThreadTimeline({
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
    selectedThreadId,
    setApprovals,
    setTimeline,
    setTimelineEntry,
    onThreadLoadFailed: handleSelectedThreadLoadFailed,
  });

  function clearTimelineEntry() {
    setTimelineEntry(idleTimelineEntry);
    setTimeline(createTimelineState());
  }

  function clearTimelineEntryForThread(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? idleTimelineEntry : current));
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
    firstMessageText,
    projectId,
  }: {
    firstMessageText: string;
    projectId?: string;
  }) {
    draftComposerTransitionOriginRef.current = composerShellRef.current?.getBoundingClientRect() ?? null;
    const threadSettings =
      projectId || draftComposerEditedRef.current
        ? composerSettings
        : (await hydrateComposerDefaults(null)) ?? composerSettings;
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

  function addOptimisticTimelineUserMessage({
    skillMentions,
    text,
    threadId,
  }: {
    skillMentions: TimelineSkillMention[];
    text: string;
    threadId: string;
  }): string | null {
    if (selectedThreadIdRef.current !== threadId) {
      return null;
    }
    const clientRequestId = createClientRequestId();
    setTimeline((current) => addOptimisticUserMessage(current, {
      clientRequestId,
      skillMentions,
      text,
      threadId,
    }));
    return clientRequestId;
  }

  function markOptimisticTimelineUserMessageSent(clientRequestId: string) {
    setTimeline((current) => markOptimisticUserMessageSent(current, clientRequestId));
  }

  function removeOptimisticTimelineUserMessage(clientRequestId: string) {
    setTimeline((current) => removeOptimisticUserMessage(current, clientRequestId));
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

  function handleTimelineReady(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "streamingLive", threadId } : current));
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

  const handleArchiveSelectedThread = useEventCallback(() => void handleArchiveThread());
  const handleArchiveThreadById = useEventCallback((threadId: string) => void handleArchiveThread(threadId));
  const handleCloseLightbox = useEventCallback(() => setLightboxImage(null));
  const handleCloseMarkdownPreview = useEventCallback(() => setMarkdownPreview(null));
  const handleClosePreferences = useEventCallback(() => setPreferencesOpen(false));
  const handleOpenPreferences = useEventCallback(() => setPreferencesOpen(true));
  const handleTimelineReadyForSelectedThread = useEventCallback(() => {
    const threadId = selectedThreadIdRef.current;
    if (threadId) {
      handleTimelineReady(threadId);
    }
  });
  const stableHandleCreateProject = useEventCallback(handleCreateProject);
  const stableHandleCreateChat = useEventCallback(handleCreateChat);
  const stableHandleCreateThread = useEventCallback(handleCreateThread);
  const stableHandleDraftProjectChange = useEventCallback(handleDraftProjectChange);
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
  const handleShowMobileSidebar = useEventCallback(() => {
    pushKodexRoute({
      panel: "threads",
      projectId: selectedMainPane === "project" ? selectedProjectPaneId : null,
      threadId: selectedMainPane === "thread" ? selectedThreadIdRef.current : null,
      view: selectedMainPane,
    });
    setMobilePanel("threads");
  });
  const handleShowMobileThread = useEventCallback(() => {
    pushKodexRoute({
      panel: null,
      projectId: selectedMainPane === "project" ? selectedProjectPaneId : null,
      threadId: selectedMainPane === "thread" ? selectedThreadIdRef.current : null,
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
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
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
  const selectedGeneratedUiSession = selectedGeneratedUiQuery.data ?? null;
  const selectedGeneratedUiKey = selectedGeneratedUiSession
    ? `${selectedGeneratedUiSession.id}:${selectedGeneratedUiSession.revision}`
    : null;
  const generatedUiAvailable = selectedGeneratedUiSession !== null;
  const generatedUiHidden = generatedUiAvailable && hiddenGeneratedUiKey === selectedGeneratedUiKey;
  const generatedUiVisible = generatedUiAvailable && !generatedUiHidden;

  const handleHideGeneratedUi = useCallback(() => {
    if (selectedGeneratedUiKey) {
      setHiddenGeneratedUiKey(selectedGeneratedUiKey);
    }
  }, [selectedGeneratedUiKey]);

  const handleShowGeneratedUi = useCallback(() => {
    setHiddenGeneratedUiKey(null);
  }, []);

  const handleGeneratedUiSubmit = useEventCallback(
    async (request: GeneratedUiSubmitRequest): Promise<GeneratedUiSubmitResponse> => {
      const session = selectedGeneratedUiSession;
      if (!session) {
        return Promise.reject(new Error("No generated UI session is available."));
      }
      const threadId = session.threadId;
      let optimisticClientRequestId: string | null = null;
      markThreadActive(threadId);
      optimisticClientRequestId = addOptimisticTimelineUserMessage({
        skillMentions: [],
        text: request.message,
        threadId,
      });
      try {
        const response = await submitGeneratedUiMutation.mutateAsync({
          request,
          sessionId: session.id,
        });
        if (response.input.queuedInput) {
          if (optimisticClientRequestId) {
            removeOptimisticTimelineUserMessage(optimisticClientRequestId);
          }
          upsertQueuedInput(response.input.queuedInput);
          return response;
        }
        if (optimisticClientRequestId) {
          markOptimisticTimelineUserMessageSent(optimisticClientRequestId);
        }
        markThreadMaterialized(threadId);
        return response;
      } catch (error) {
        if (optimisticClientRequestId) {
          removeOptimisticTimelineUserMessage(optimisticClientRequestId);
        }
        markThreadIdle(threadId);
        throw error;
      }
    },
  );
  const generatedUiPane =
    selectedGeneratedUiSession && generatedUiVisible ? (
      <GeneratedUiPane
        colorSchemeId={colorSchemeId}
        isSubmitting={submitGeneratedUiMutation.isPending}
        onHide={handleHideGeneratedUi}
        onSubmit={handleGeneratedUiSubmit}
        session={selectedGeneratedUiSession}
      />
    ) : null;

  return (
    <>
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
          composerPanelProps={{
          activeSelectedTurnId, attachmentInputRef, canCompose, composerDraftKey, composerResetToken, composerSettings, composerSettingsError,
          composerCwd, composerShellRef, contextUsage: selectedContextUsage, currentProjectName: selectedProject?.name ?? null,
          draftProjectSelector: isDraftThreadSelected
            ? {
                onChange: stableHandleDraftProjectChange,
                projects: orderedProjects,
                value: draftChatThreadSelected ? null : draftThreadProjectId,
              }
            : undefined,
          selectedGitBranch: selectedThread?.gitInfo?.branch ?? null, isDraftThreadSelected, isDraftComposerTransitioning, isComposerDragActive,
          isComposerSubmitting, isQueuedTurnStartPending, isSelectedTimelineReady, skillsInvalidationGeneration, models,
          onAbortQueuedSteer: handleAbortQueuedSteer, onAttachmentInputChange: handleAttachmentInputChange,
          onComposerDragLeave: handleComposerDragLeave, onComposerDragOver: handleComposerDragOver, onComposerDrop: handleComposerDrop,
          onComposerKeyDown: handleComposerKeyDown, onComposerPaste: handleComposerPaste, onComposerSettingsChange: handleComposerSettingsChange,
          onImageOpen: setLightboxImage, onRemovePendingAttachment: removePendingAttachment, onStopTurn: handleStopTurn,
          onSubmitQueuedSteer: handleSubmitQueuedSteer, onSubmitTurn: handleSubmitTurn, pendingAttachments, queuedSteerRows,
          selectedThreadPresent: selectedThread !== null || isSelectedTimelineLoading,
        }}
        generatedUiOpen={generatedUiVisible}
        generatedUiPane={generatedUiPane}
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
        sidebarWidth={sidebarWidth}
        threadPanelProps={{
          errorMessage, generatedUiAvailable, generatedUiHidden, imagePreviewUrlsByPath, isDraftThreadSelected, isSelectedTimelineLoading,
          onArchiveThread: handleArchiveSelectedThread, onApprovalDecision: handleApprovalDecision, onImageOpen: setLightboxImage,
          onGeneratedUiHide: handleHideGeneratedUi,
          onGeneratedUiShow: handleShowGeneratedUi,
          onMarkdownOpen: setMarkdownPreview,
          onPinThread: stableHandlePinThread,
          onRenameThread: stableHandleRenameThread,
          onSetThreadNotificationsEnabled: stableHandleSetThreadNotificationsEnabled,
          onShowMobileSidebar: handleShowMobileSidebar, onTimelineReady: handleTimelineReadyForSelectedThread,
          onSubagentSidebarToggle: () => setSubagentSidebarOpen((current) => !current),
          onLoadOlderHistory: loadOlderHistory,
          onUnpinThread: stableHandleUnpinThread, pendingTitleThreadIds,
          scrollParentElement: timelineScrollElement, selectedThread, selectedThreadApprovals, selectedThreadTitle,
          selectedThreadUnavailableId: unavailableThreadId,
          selectedTimelineEntry, setTimelineScrollElement, showDebugEvents,
          subagentSidebarOpen,
          subagentToggleVisible: selectedThreadSubagents.length > 0,
          subagentViewer,
          threadSyncNotice,
          timeline,
        }}
        workspaceSidebarProps={{
          account, approvals, chatThreads: sidebarChatThreads, dataState: sidebarDataState, hoveredThreadActionId, isSidebarResizing, loginState,
          chatThreadsHasMore: chatThreadsNextCursor !== null,
          chatThreadsPaginationState,
          onArchiveThread: handleArchiveThreadById, onCancelLogin: handleCancelLogin,
          onCreateChat: stableHandleCreateChat, onCreateProject: stableHandleCreateProject, onCreateThread: stableHandleCreateThread, onLogin: handleLogin, onLogout: handleLogout,
          onLoadMoreChatThreads: handleLoadMoreChatThreads, onLoadMoreProjectThreads: handleLoadMoreProjectThreads,
          onPinThread: stableHandlePinThread,
          onOpenPreferences: handleOpenPreferences, onProjectCwdChange: handleProjectCwdChange, onProjectDirectoryCreateCancel: () => setProjectDirectoryCreateCwd(null),
          onProjectFormOpenChange: setProjectFormOpen, onReorderProjects: handleReorderProjects, onSelectChatThread: stableHandleSelectChatThread,
          onSelectAutomations: stableHandleSelectAutomations, onSelectPinnedThread: stableHandleSelectPinnedThread, onSelectProjectSettings: stableHandleSelectProjectSettings, onSelectThread: stableHandleSelectThread, onUnpinThread: stableHandleUnpinThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onSidebarResizeKeyDown: handleSidebarResizeKeyDown,
          onSidebarResizePointerDown: handleSidebarResizePointerDown, onThreadActionHoverChange: setHoveredThreadActionId,
          pinnedThreads: sidebarPinnedThreads,
          pendingTitleThreadIds, projectCwd, projectDirectoryCreatePending: projectDirectoryCreateCwd === projectCwd.trim() && projectCwd.trim().length > 0,
          projectThreadHasMoreById: Object.fromEntries(Object.entries(projectThreadNextCursors).map(([projectId, cursor]) => [projectId, cursor !== null])),
          projectThreadPaginationStateById,
          projectFormOpen, projects: orderedProjects, selectedMainPane, selectedProjectId, selectedThreadId: selectedMainPane === "thread" ? selectedThreadId : null,
          showDebugEvents, sidebarWidth, threadsByProjectId: sidebarThreadsByProjectId, usageLimitLines,
        }}
      />
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
