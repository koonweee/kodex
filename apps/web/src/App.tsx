import { MantineProvider } from "@mantine/core";
import { QueryClientProvider, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isApprovalEvent } from "./approvals/state";
import { useApprovalsState } from "./approvals/useApprovalsState";
import {
  formatUsageLimitLines,
  usageLimitSnapshotFromEvent,
  usageLimitSnapshotFromResponse,
} from "./account/rateLimits";
import { useAccountSession } from "./account/useAccountSession";
import {
  archiveThread,
  attachThread,
  createAutomation,
  createChatThread,
  createProject,
  createThread,
  deleteAutomation,
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
  unpinThread,
  updateAutomation,
  type Approval,
  type Automation,
  type AutomationCreateRequest,
  type AutomationUpdateRequest,
  type EventEnvelope,
  type Project,
  type QueuedInput,
  type ThreadSummary,
  type ThreadSubagentSummary,
} from "./api/client";
import { applyMcpLifecycleEvent } from "./api/mcpCache";
import { queryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import {
  applyCachedAutomationEvent,
  deleteCachedAutomation,
  mergeAutomationData,
  upsertCachedAutomation,
} from "./automations/cache";
import { automationThreadOptions } from "./automations/threadOptions";
import { createThreadOptions } from "./composer/settings";
import { useComposerSettingsState } from "./composer/useComposerSettingsState";
import { useComposerOrchestration } from "./composer/useComposerOrchestration";
import { createEventStreamClient } from "./events/stream";
import { MarkdownPreviewPane } from "./files/MarkdownPreviewPane";
import type { MarkdownPreviewRequest } from "./files/types";
import { ImageLightbox } from "./images/ImageLightbox";
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
import { ThemeWorkbench } from "./theme/ThemeWorkbench";
import { idleTimelineEntry, type TimelineEntry } from "./timeline/entry";
import { useSelectedThreadTimeline, type ThreadSyncNotice } from "./timeline/useSelectedThreadTimeline";
import {
  clearAvailableThreadTitles,
  markThreadTitlePending,
  optimisticThreadSummary,
  threadDisplayTitle,
  threadHasDisplayTitle,
  withoutPinnedProjectThreads,
  withoutPinnedThreads,
  type ThreadsByProjectId,
} from "./threads/helpers";
import {
  applyThreadPinState as applyThreadPinStateToCache,
  findCachedThread,
  mergeChatThreadData,
  mergeSelectedThreadDetailIntoSidebarSummary,
  mergePinnedThreadData,
  mergeProjectThreadData,
  mergeProjectThreadSnapshot,
  pinnedTombstonesAddedDuringSnapshot,
  removeThreadEverywhere,
  replaceThreadEverywhere,
  updateThreadEverywhere,
  upsertChatThread,
  upsertPinnedThread,
  upsertProjectThread,
} from "./threads/cache";
import {
  deleteCachedQueuedInput,
  mergeQueuedInputData,
  upsertCachedQueuedInput,
} from "./queuedInputs/cache";
import { threadPinUpdateFromEvent, threadUpsertFromEvent } from "./threads/events";
import { SubagentThreadViewer } from "./threads/SubagentThreadViewer";
import {
  applySidebarProjectOrder,
  loadSidebarProjectOrder,
  saveSidebarProjectOrder,
} from "./threads/projectOrder";
import { useSidebarThreadsSnapshot } from "./threads/useSidebarThreadsSnapshot";
import { useThreadMetadata } from "./threads/useThreadMetadata";
import { useThreadReadState } from "./threads/useThreadReadState";
import {
  createTimelineState,
  type TimelineState,
} from "./timeline/reducer";
import { errorMessageFrom } from "./shared/values";
import { KodexShellView } from "./shell/KodexShellView";
import type { MobilePanel } from "./shell/KodexShellView";
import { automationsPath, emptyPath, parseKodexLocation, projectPath, threadPath, type KodexRoute, type KodexMainPane } from "./shell/navigation";
import { useSidebarResize } from "./shell/useSidebarResize";
import "./App.css";

const NEW_THREAD_TITLE = "New thread";
const DRAFT_COMPOSER_TRANSITION_MS = 280;
type SidebarPaginationState = "idle" | "loading" | "error";

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

  const isThemeWorkbench = typeof window !== "undefined" && window.location.pathname === "/__theme";

  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider forceColorScheme={colorScheme.mode} theme={theme}>
        {isThemeWorkbench ? (
          <ThemeWorkbench colorSchemeId={colorSchemeId} onColorSchemeChange={setColorSchemeId} />
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialRoute.projectId ?? null);
  const [selectedMainPane, setSelectedMainPane] = useState<KodexMainPane>(initialRoute.view ?? "thread");
  const [selectedProjectPaneId, setSelectedProjectPaneId] = useState<string | null>(initialRoute.projectId ?? null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialRoute.threadId);
  const [routeSelectedThread, setRouteSelectedThread] = useState<ThreadSummary | null>(null);
  const [unavailableThreadId, setUnavailableThreadId] = useState<string | null>(null);
  const [draftChatThreadSelected, setDraftChatThreadSelected] = useState(initialRoute.threadId === null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
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
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(initialRoute.panel ?? "chat");
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewRequest | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferenceSection>("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const [subagentSidebarOpen, setSubagentSidebarOpen] = useState(false);
  const [selectedSubagentThreadId, setSelectedSubagentThreadId] = useState<string | null>(null);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const approvalsRef = useRef<Approval[]>([]);
  const attachingThreadIdsRef = useRef<Set<string>>(new Set());
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const pinnedThreadsRef = useRef<ThreadSummary[]>([]);
  const routeSelectedThreadRef = useRef<ThreadSummary | null>(null);
  const pendingTitleThreadIdsRef = useRef<Set<string>>(new Set());
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const chatThreadsLoadingCursorRef = useRef<string | null>(null);
  const projectThreadLoadingCursorsRef = useRef<Record<string, string>>({});
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const directMobileDeepLinkSeededRef = useRef(false);
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
        const response = await listThreadsPage(project.id);
        setProjectThreadNextCursors((current) => ({ ...current, [project.id]: response.nextCursor ?? null }));
        return mergeProjectThreadData(
          queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(project.id)),
          response.threads,
          routeSelectedThreadRef.current,
          selectedThreadIdRef.current,
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
      const response = await listChatThreadsPage();
      setChatThreadsNextCursor(response.nextCursor ?? null);
      return mergeChatThreadData(
        queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads),
        response.threads,
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
  const selectedThreadSubagentsQuery = useQuery({
    enabled: selectedMainPane === "thread" && selectedThread !== null && isSelectedTimelineReady,
    queryKey: selectedThread ? queryKeys.threadSubagents(selectedThread.id) : ["threads", "none", "subagents"],
    queryFn: async () => {
      const threadId = selectedThread?.id;
      return threadId ? listThreadSubagents(threadId) : [];
    },
    refetchInterval: selectedThread?.status === "active" ? 2000 : false,
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
    composerSettings,
    composerSettingsError,
    draftComposerEditedRef,
    handleComposerSettingsChange,
    hydrateComposerDefaults,
    models,
  } = useComposerSettingsState({
    draftChatThreadSelected,
    onError: reportError,
    selectedProjectId,
    selectedThread,
  });
  const { applyCompletedAgentTurnEvent, markCompletedAgentTurnSeen } = useThreadReadState({
    chatThreads,
    onError: reportError,
    selectedThreadIdRef,
    threadsByProjectId,
    pinnedThreads,
    updateThreadEverywhere: patchThreadEverywhere,
  });
  const { applyNotificationEvent } = useKodexNotifications({
    chatThreads,
    pinnedThreads,
    routeSelectedThread,
    selectedThreadId,
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
  const isDraftThreadSelected =
    draftChatThreadSelected || (draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId);
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
    draftChatThreadSelected,
    draftThreadProjectId,
    isDraftThreadSelected,
    onCreateDraftThread: createDraftThreadFromComposer,
    onError: reportError,
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
    function handlePopState() {
      applyBrowserRoute(currentKodexRoute());
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (directMobileDeepLinkSeededRef.current) {
      return;
    }
    directMobileDeepLinkSeededRef.current = true;
    const route = currentKodexRoute();
    if (!route.threadId || route.panel !== null || !isMobileViewport()) {
      return;
    }
    const state = historyState();
    if (state.kodexDirectMobileDeepLinkSeeded === true) {
      return;
    }
    const nextState = { ...state, kodexDirectMobileDeepLinkSeeded: true };
    window.history.replaceState(nextState, "", threadPath(route.threadId, { panel: "threads" }));
    window.history.pushState(nextState, "", threadPath(route.threadId));
  }, []);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

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

  useEffect(() => {
    routeSelectedThreadRef.current = routeSelectedThread;
  }, [routeSelectedThread]);

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

  useEffect(() => {
    const client = createEventStreamClient({
      onEvent: (event) => {
        applyAutomationStreamEvent(event);
        applyQueueEvent(event);
        applyThreadPinEvent(event);
        applyThreadUpsertEvent(event);
        applyThreadMetadataEvent(event);
        applyCompletedAgentTurnEvent(event);
        applyNotificationEvent(event);
        refreshSidebarThreadsForLiveEvent(event);
        invalidateSelectedSubagentsForEvent(event);
        const nextUsageLimitSnapshot = usageLimitSnapshotFromEvent(event);
        if (nextUsageLimitSnapshot) {
          liveUsageLimitSnapshotReceivedRef.current = true;
          queryClientForShell.setQueryData(queryKeys.rateLimits, nextUsageLimitSnapshot);
        }
        if (isApprovalEvent(event)) {
          setApprovals((current) => applyApprovalEventWithTombstone(current, event));
        }
        if (event.kind === "skills.changed") {
          setSkillsInvalidationGeneration((current) => current + 1);
        }
        applyMcpLifecycleEvent(queryClientForShell, event);
      },
    });
    client.connect();
    return client.close;
  }, []);

  useEffect(() => {
    if (isSelectedThreadSnapshotDeferred) {
      return;
    }
    if (!selectedThread || !selectedThreadShouldAttachLive(selectedThread)) {
      return;
    }
    if (attachingThreadIdsRef.current.has(selectedThread.id)) {
      return;
    }

    let cancelled = false;
    attachingThreadIdsRef.current.add(selectedThread.id);
    const attachingThreadId = selectedThread.id;
    attachThread(attachingThreadId)
      .then((response) => {
        attachingThreadIdsRef.current.delete(attachingThreadId);
        if (!cancelled && response.thread) {
          replaceThread(response.thread);
        }
      })
      .catch((error) => {
        attachingThreadIdsRef.current.delete(attachingThreadId);
        if (!cancelled) {
          reportError(error, `Selected thread attach failed (${attachingThreadId})`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSelectedThreadSnapshotDeferred, selectedThread?.id, selectedThread?.status]);

  const { loadOlderHistory } = useSelectedThreadTimeline({
    isSelectedThreadSnapshotDeferred,
    onApprovalEvent: applyApprovalEventWithTombstone,
    onError: (error) => {
      const threadId = selectedThreadIdRef.current;
      reportError(error, threadId ? `Selected thread load failed (${threadId})` : "Selected thread load failed");
    },
    onSnapshotThread: handleSelectedThreadSnapshot,
    onSyncNotice: setThreadSyncNotice,
    onThreadMetadataEvent: applyThreadMetadataEvent,
    onQueueEvent: applyQueueEvent,
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

  function selectProject(projectId: string) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    selectedProjectIdRef.current = projectId;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(projectId);
    }
    setSelectedProjectId(projectId);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
    clearTimelineEntry();
  }

  function handleCreateThread(projectId: string) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    clearTimelineEntry();
    resetComposerDraft();
  }

  function handleCreateChat() {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    draftComposerEditedRef.current = false;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(null);
    }
    selectedProjectIdRef.current = null;
    setSelectedProjectId(null);
    setDraftChatThreadSelected(true);
    setDraftThreadProjectId(null);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    clearTimelineEntry();
    resetComposerDraft();
  }

  function handleDraftProjectChange(projectId: string | null) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    pushKodexRoute({ panel: null, threadId: null });
    setMobilePanel("chat");
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    clearTimelineEntry();

    if (projectId === null) {
      selectedProjectIdRef.current = null;
      setSelectedProjectId(null);
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
      if (!draftComposerEditedRef.current) {
        void hydrateComposerDefaults(null);
      }
      return;
    }

    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(projectId);
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(projectId);
    }
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
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    selectedProjectIdRef.current = projectId ?? null;
    setSelectedProjectId(projectId ?? null);
    selectedThreadIdRef.current = thread.id;
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(thread);
    beginMaterializingTimelineEntry(thread.id);
    setSelectedThreadId(thread.id);
    pushKodexRoute({ panel: null, threadId: thread.id });
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

  function handleSelectThread(projectId: string, threadId: string) {
    pushKodexRoute({ panel: null, threadId });
    selectKnownProjectThread(projectId, threadId);
  }

  function handleSelectChatThread(threadId: string) {
    pushKodexRoute({ panel: null, threadId });
    selectKnownChatThread(threadId);
  }

  function handleSelectPinnedThread(threadId: string) {
    pushKodexRoute({ panel: null, threadId });
    selectKnownPinnedThread(threadId);
  }

  function selectKnownProjectThread(projectId: string, threadId: string) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    if (projectId === selectedProjectIdRef.current && threadId === selectedThreadIdRef.current) {
      return;
    }
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    selectedThreadIdRef.current = threadId;
    beginTimelineEntry(threadId);
    setSelectedThreadId(threadId);
  }

  function selectKnownChatThread(threadId: string) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    if (selectedProjectIdRef.current === null && threadId === selectedThreadIdRef.current) {
      return;
    }
    draftComposerEditedRef.current = false;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(null);
    }
    selectedProjectIdRef.current = null;
    setSelectedProjectId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    selectedThreadIdRef.current = threadId;
    beginTimelineEntry(threadId);
    setSelectedThreadId(threadId);
  }

  function selectKnownPinnedThread(threadId: string) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    setMobilePanel("chat");
    if (selectedProjectIdRef.current === null && threadId === selectedThreadIdRef.current) {
      return;
    }
    selectedProjectIdRef.current = null;
    setSelectedProjectId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    selectedThreadIdRef.current = threadId;
    beginTimelineEntry(threadId);
    setSelectedThreadId(threadId);
  }

  function selectRouteThread(threadId: string) {
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    const knownSelection = findKnownThreadSelection(threadId);
    if (knownSelection?.kind === "project") {
      selectKnownProjectThread(knownSelection.projectId, threadId);
      return;
    }
    if (knownSelection?.kind === "chat") {
      selectKnownChatThread(threadId);
      return;
    }
    if (knownSelection?.kind === "pinned") {
      selectKnownPinnedThread(threadId);
      return;
    }
    setMobilePanel("chat");
    if (threadId === selectedThreadIdRef.current && selectedProjectIdRef.current === null) {
      return;
    }
    selectedProjectIdRef.current = null;
    setSelectedProjectId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    setUnavailableThreadId(null);
    setRouteSelectedThreadState(null);
    selectedThreadIdRef.current = threadId;
    beginTimelineEntry(threadId);
    setSelectedThreadId(threadId);
  }

  function findKnownThreadSelection(
    threadId: string,
  ): { kind: "chat" } | { kind: "pinned" } | { kind: "project"; projectId: string } | null {
    for (const [projectId, threads] of Object.entries(threadsByProjectIdRef.current)) {
      if (threads.some((thread) => thread.id === threadId)) {
        return { kind: "project", projectId };
      }
    }
    if (chatThreadsRef.current.some((thread) => thread.id === threadId)) {
      return { kind: "chat" };
    }
    if (pinnedThreadsRef.current.some((thread) => thread.id === threadId)) {
      return { kind: "pinned" };
    }
    return null;
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
      clearTimelineEntry();
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      if (draftProjectId) {
        setDraftChatThreadSelected(false);
        setDraftThreadProjectId(draftProjectId);
        if (!draftComposerEditedRef.current) {
          void hydrateComposerDefaults(draftProjectId);
        }
      } else {
        draftComposerEditedRef.current = false;
        setDraftChatThreadSelected(true);
        setDraftThreadProjectId(null);
        void hydrateComposerDefaults(null);
      }
      replaceKodexRoute({ panel: null, threadId: null });
    }
  }

  function handleSelectAutomations() {
    pushKodexRoute({ panel: null, threadId: null, view: "automations" });
    setMobilePanel("chat");
    setSelectedMainPane("automations");
    setSelectedProjectPaneId(null);
  }

  function handleSelectProjectSettings(projectId: string) {
    pushKodexRoute({ panel: null, projectId, threadId: null, view: "project" });
    setMobilePanel("chat");
    setSelectedMainPane("project");
    setSelectedProjectPaneId(projectId);
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(null);
    setDraftChatThreadSelected(false);
    setDraftThreadProjectId(null);
    clearTimelineEntry();
  }

  function applyAutomationStreamEvent(event: EventEnvelope) {
    if (event.kind !== "automation.item_upsert" && event.kind !== "automation.item_deleted") {
      return;
    }
    const automationQueryState = queryClientForShell.getQueryState(queryKeys.automations);
    if (automationQueryState?.data === undefined && automationQueryState?.fetchStatus !== "fetching") {
      return;
    }
    applyCachedAutomationEvent(queryClientForShell, event);
    if (automationQueryState.fetchStatus === "fetching") {
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.automations });
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

  function setRouteSelectedThreadState(thread: ThreadSummary | null) {
    routeSelectedThreadRef.current = thread;
    setRouteSelectedThread(thread);
  }

  function patchThreadEverywhere(
    threadId: string,
    patcher: (thread: ThreadSummary) => ThreadSummary,
  ) {
    updateThreadEverywhere(queryClientForShell, threadId, patcher);
    if (routeSelectedThreadRef.current?.id === threadId) {
      setRouteSelectedThreadState(patcher(routeSelectedThreadRef.current));
    }
  }

  function replaceThread(thread: ThreadSummary) {
    if (thread.id === selectedThreadIdRef.current) {
      setRouteSelectedThreadState(thread);
    }
    const cachedThread = findKnownThread(thread.id);
    const sidebarThread = cachedThread ? mergeSelectedThreadDetailIntoSidebarSummary(cachedThread, thread) : thread;
    replaceThreadEverywhere(queryClientForShell, thread);
    if (sidebarThread.pinnedAt) {
      upsertPinnedThread(queryClientForShell, sidebarThread);
    } else {
      removeThreadEverywhere(queryClientForShell, thread.id, { pinnedOnly: true });
    }
    if (threadHasDisplayTitle(thread)) {
      setPendingTitleThreadIds((current) => {
        if (!current.has(thread.id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
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

  function applyThreadPinEvent(event: EventEnvelope) {
    const update = threadPinUpdateFromEvent(event);
    if (!update) {
      return;
    }
    applyThreadPinState(update.threadId, update.pinnedAt);
  }

  function applyThreadUpsertEvent(event: EventEnvelope) {
    const update = threadUpsertFromEvent(event);
    if (!update) {
      return;
    }

    if (update.scope === "project") {
      upsertProjectThread(queryClientForShell, update.projectId, update.thread);
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.projectThreads(update.projectId) });
    } else {
      upsertChatThread(queryClientForShell, update.thread);
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.chatThreads });
    }

    if (update.thread.pinnedAt) {
      upsertPinnedThread(queryClientForShell, update.thread);
    } else {
      removeThreadEverywhere(queryClientForShell, update.thread.id, { pinnedOnly: true });
    }

    if (threadHasDisplayTitle(update.thread)) {
      setPendingTitleThreadIds((current) => {
        if (!current.has(update.thread.id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(update.thread.id);
        return next;
      });
    }
  }

  function refreshSidebarThreadsForLiveEvent(event: EventEnvelope) {
    if (!event.threadId || !eventCanRefreshSidebarThread(event)) {
      return;
    }

    const location = findThreadSidebarLocation(event.threadId);
    if (!location) {
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.projectThreadsRoot });
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.chatThreads });
      return;
    }

    if (!eventShouldRefreshKnownSidebarThread(event, location.thread)) {
      return;
    }

    if (location.scope === "project") {
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.projectThreads(location.projectId) });
    } else {
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.chatThreads });
    }
  }

  function eventShouldRefreshKnownSidebarThread(event: EventEnvelope, thread: ThreadSummary) {
    return (
      !threadHasDisplayTitle(thread) ||
      event.kind === "thread_view.patch"
    );
  }

  function findThreadSidebarLocation(
    threadId: string,
  ): { scope: "project"; projectId: string; thread: ThreadSummary } | { scope: "chat"; thread: ThreadSummary } | null {
    for (const [projectId, threads] of Object.entries(threadsByProjectIdRef.current)) {
      const thread = threads.find((item) => item.id === threadId);
      if (thread) {
        return { scope: "project", projectId, thread };
      }
    }
    const chatThread = chatThreadsRef.current.find((thread) => thread.id === threadId);
    return chatThread ? { scope: "chat", thread: chatThread } : null;
  }

  function eventCanRefreshSidebarThread(event: EventEnvelope) {
    return (
      event.kind === "thread_view.patch" ||
      event.kind === "timeline.thread_metadata"
    );
  }

  function applyThreadPinState(threadId: string, pinnedAt: string | null) {
    setPinnedStateTrusted(true);
    const knownThread = findKnownThread(threadId);
    setRouteSelectedThreadState(
      routeSelectedThreadRef.current?.id === threadId
        ? withThreadPinnedAt(routeSelectedThreadRef.current, pinnedAt)
        : routeSelectedThreadRef.current,
    );
    applyThreadPinStateToCache(queryClientForShell, threadId, pinnedAt, knownThread);
    if (pinnedAt && !knownThread) {
      void queryClientForShell.invalidateQueries({ queryKey: queryKeys.pinnedThreads });
      return;
    }
  }

  function invalidateSelectedSubagentsForEvent(event: EventEnvelope) {
    const threadId = selectedThreadIdRef.current;
    if (!threadId || event.threadId !== threadId || !eventCanAffectSubagentDiscovery(event)) {
      return;
    }
    void queryClientForShell.invalidateQueries({ queryKey: queryKeys.threadSubagents(threadId) });
  }

  function findKnownThread(threadId: string): ThreadSummary | null {
    for (const threads of Object.values(threadsByProjectIdRef.current)) {
      const thread = threads.find((item) => item.id === threadId);
      if (thread) {
        return thread;
      }
    }
    return (
      chatThreadsRef.current.find((thread) => thread.id === threadId) ??
      pinnedThreadsRef.current.find((thread) => thread.id === threadId) ??
      (routeSelectedThreadRef.current?.id === threadId ? routeSelectedThreadRef.current : null)
    );
  }

  function reportError(error: unknown, context?: string) {
    const message = errorMessageFrom(error);
    setErrorMessage(context ? `${context}: ${message}` : message);
  }

  function applyQueueEvent(event: EventEnvelope) {
    if (event.kind === "turn_queue.item_upsert") {
      const row = event.payload as QueuedInput;
      if (!row?.id || !row.threadId) {
        return;
      }
      upsertQueuedInput(row);
      return;
    }
    if (event.kind !== "turn_queue.item_deleted") {
      return;
    }
    const payload = event.payload as { id?: unknown; threadId?: unknown };
    const id = typeof payload.id === "string" ? payload.id : null;
    const threadId = typeof payload.threadId === "string" ? payload.threadId : event.threadId;
    if (!id || !threadId) {
      return;
    }
    removeQueuedInput(threadId, id);
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

  function applyBrowserRoute(route: KodexRoute) {
    if (route.view === "automations") {
      setMobilePanel(route.panel ?? "chat");
      setSelectedMainPane("automations");
      setSelectedProjectPaneId(null);
      return;
    }
    if (route.view === "project" && route.projectId) {
      setMobilePanel(route.panel ?? "chat");
      setSelectedMainPane("project");
      setSelectedProjectPaneId(route.projectId);
      selectedProjectIdRef.current = route.projectId;
      setSelectedProjectId(route.projectId);
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      setDraftChatThreadSelected(false);
      setDraftThreadProjectId(null);
      clearTimelineEntry();
      return;
    }
    setSelectedMainPane("thread");
    setSelectedProjectPaneId(null);
    if (!route.threadId) {
      setMobilePanel(route.panel ?? "chat");
      selectedProjectIdRef.current = null;
      selectedThreadIdRef.current = null;
      setSelectedProjectId(null);
      setSelectedThreadId(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      setDraftChatThreadSelected(true);
      setDraftThreadProjectId(null);
      clearTimelineEntry();
      return;
    }
    if (route.threadId === selectedThreadIdRef.current) {
      setMobilePanel(route.panel ?? "chat");
      return;
    }
    selectRouteThread(route.threadId);
    setMobilePanel(route.panel ?? "chat");
  }

  function pushKodexRoute(route: KodexRoute) {
    const nextPath =
      route.view === "automations"
        ? automationsPath({ panel: route.panel })
        : route.view === "project" && route.projectId
          ? projectPath(route.projectId, { panel: route.panel })
        : route.threadId
          ? threadPath(route.threadId, { panel: route.panel })
          : emptyPath({ panel: route.panel });
    if (currentLocationPath() === nextPath) {
      return;
    }
    window.history.pushState({ kodexRoute: true }, "", nextPath);
  }

  function replaceKodexRoute(route: KodexRoute) {
    const nextPath =
      route.view === "automations"
        ? automationsPath({ panel: route.panel })
        : route.view === "project" && route.projectId
          ? projectPath(route.projectId, { panel: route.panel })
        : route.threadId
          ? threadPath(route.threadId, { panel: route.panel })
          : emptyPath({ panel: route.panel });
    if (currentLocationPath() === nextPath) {
      return;
    }
    window.history.replaceState({ kodexRoute: true }, "", nextPath);
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
      const response = await listChatThreadsPage({ cursor });
      queryClientForShell.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
        mergeChatThreadData(current, response.threads),
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
      const response = await listThreadsPage(projectId, { cursor });
      mergeProjectThreadSnapshot(
        queryClientForShell,
        projectId,
        response.threads,
        routeSelectedThreadRef.current,
        selectedThreadIdRef.current,
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
    () => (pinnedStateIsTrusted ? withoutPinnedProjectThreads(threadsByProjectId) : threadsByProjectId),
    [pinnedStateIsTrusted, threadsByProjectId],
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
          errorMessage, imagePreviewUrlsByPath, isDraftThreadSelected, isSelectedTimelineLoading,
          onArchiveThread: handleArchiveSelectedThread, onApprovalDecision: handleApprovalDecision, onImageOpen: setLightboxImage,
          onMarkdownOpen: setMarkdownPreview,
          onPinThread: stableHandlePinThread,
          onRenameThread: stableHandleRenameThread,
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
      <ImageLightbox image={lightboxImage} onClose={handleCloseLightbox} />
      <MarkdownPreviewPane preview={markdownPreview} threadId={selectedThreadId ?? undefined} onClose={handleCloseMarkdownPreview} />
    </>
  );
}

function selectedThreadShouldAttachLive(thread: ThreadSummary): boolean {
  return thread.status === "notLoaded" || thread.status === "active";
}

function defaultSubagent(subagents: ThreadSubagentSummary[]): ThreadSubagentSummary | null {
  return (
    subagents.find((subagent) => subagent.status === "active" || subagent.liveState === "streaming") ??
    subagents[0] ??
    null
  );
}

function eventCanAffectSubagentDiscovery(event: EventEnvelope): boolean {
  return (
    event.kind === "thread_view.patch" ||
    event.kind === "timeline.thread_metadata" ||
    event.kind === "thread_view.refresh_required"
  );
}

function queryResultLoadState(query: {
  data?: unknown;
  isError?: boolean;
  isFetching?: boolean;
  isLoading?: boolean;
} | undefined): "error" | "loaded" | "loading" | "refetching" {
  if (!query || (query.data === undefined && (query.isLoading || query.isFetching))) {
    return "loading";
  }
  if (query.isError) {
    return "error";
  }
  if (query.isFetching) {
    return "refetching";
  }
  return "loaded";
}

function currentKodexRoute(): KodexRoute {
  return parseKodexLocation(window.location);
}

function currentLocationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function historyState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
}

function isMobileViewport(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;
}

function withThreadPinnedAt(thread: ThreadSummary, pinnedAt: string | null): ThreadSummary {
  return { ...thread, pinnedAt };
}
