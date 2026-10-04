import { useThreadSections } from "./sections/useThreadSections";
import { PINNED_SECTION_ID } from "./sections/cache";
import { Group, MantineProvider } from "@mantine/core";
import { QueryClientProvider, isCancelledError, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import {
  lazy,
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
import { formatUsageLimitLines } from "./account/rateLimits";
import { useAccountSession } from "./account/useAccountSession";
import { useUsageLimits } from "./account/useUsageLimits";
import {
  archiveThread,
  createAutomation,
  createChatThread,
  createThread,
  deleteAutomation,
  getCapabilities,
  listAutomations,
  listChatThreadsPage,
  listProjects,
  listThreadsPage,
  pauseAutomation,
  renameThread,
  resumeAutomation,
  setThreadNotificationsEnabled,
  updateAutomation,
  type Approval,
  type Automation,
  type AutomationCreateRequest,
  type AutomationUpdateRequest,
  type EventEnvelope,
  type Project,
  type QueuedInput,
  type ThreadSummary,
} from "./api/client";
import { queryClient } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
import {
  deleteCachedAutomation,
  mergeAutomationData,
  upsertCachedAutomation,
} from "./automations/cache";
import { ThreadPaneComposerBridge } from "./composer/ThreadPaneComposerBridge";
import { WorkspaceProjectCreateDialog } from "./projects/ProjectCreateDialog";
import { ThreadProjectSelect } from "./projects/ThreadProjectSelect";
import { moveProject } from "./api/client";
import { refreshProjectState } from "./projects/cache";
import type { ComposerSettings } from "./ComposerFooterControls";
import type { ComposerDraftStore } from "./composer/useComposerDraftState";
import { automationThreadOptions } from "./automations/threadOptions";
import { createThreadOptions } from "./composer/settings";
import { useComposerSettingsState } from "./composer/useComposerSettingsState";
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
import {
  clearAvailableThreadTitles,
  markThreadTitlePending,
  optimisticThreadSummary,
  type ThreadsByProjectId,
} from "./threads/helpers";
import {
  mergeChatThreadData,
  mergeProjectThreadData,
  appendThreadPage,
  removeThreadEverywhere,
  upsertChatThread,
  upsertProjectThread,
} from "./threads/cache";
import {
  deleteCachedQueuedInput,
  upsertCachedQueuedInput,
} from "./queuedInputs/cache";
import { useThreadSubagents } from "./threads/useThreadSubagents";
import { useSidebarThreadCaches } from "./threads/useSidebarThreadCaches";
import { useSidebarThreadsSnapshot } from "./threads/useSidebarThreadsSnapshot";
import { useThreadMetadata } from "./threads/useThreadMetadata";
import { useThreadReadState } from "./threads/useThreadReadState";
import { useThreadViewPresence } from "./threads/useThreadViewPresence";
import { AdaptiveIconButton } from "./ui/AdaptiveIconButton";
import { errorMessageFrom } from "./shared/values";
import { KodexShellView, useNarrowThreadWorkspace } from "./shell/KodexShellView";
import {
  currentKodexRoute,
  isThemeWorkbenchRoute,
  pushKodexRoute,
} from "./shell/browserRouting";
import { queryResultLoadState } from "./shell/queryResultLoadState";
import { useSidebarResize } from "./shell/useSidebarResize";
import { useShellSelection } from "./shell/useShellSelection";
import {
  WorkspaceProvider,
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


export function App({ queryClientInstance = queryClient, workspacePaneStore }: AppProps = {}) {
  const [colorSchemeId, setColorSchemeId] = useState<KodexColorSchemeId>(() => readStoredKodexColorScheme());
  const colorScheme = useMemo(() => getKodexColorScheme(colorSchemeId), [colorSchemeId]);
  const theme = useMemo(() => createKodexMantineTheme(colorScheme), [colorScheme]);

  useLayoutEffect(() => {
    writeStoredKodexColorScheme(colorSchemeId);
    applyKodexColorScheme(document.documentElement, colorScheme);
  }, [colorScheme, colorSchemeId]);

  useEffect(() => installLiveLongTaskObserver(), []);

  const isThemeWorkbench = isThemeWorkbenchRoute();

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
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewRequest | null>(null);
  const [paneImagePreviewUrlsByPath, setPaneImagePreviewUrlsByPath] = useState<Record<string, string>>({});
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferenceSection>("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [, setComposerResetToken] = useState(0);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const approvalsRef = useRef<Approval[]>([]);
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const sectionThreadsRef = useRef<ThreadSummary[]>([]);
  const pendingTitleThreadIdsRef = useRef<Set<string>>(new Set());
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const chatThreadsLoadingCursorRef = useRef<string | null>(null);
  const projectThreadLoadingCursorsRef = useRef<Record<string, string>>({});
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const composerDraftStoreRef = useRef<ComposerDraftStore>(new Map());
  const activeDraftComposerPaneIdRef = useRef<string | null>(null);
  const activeDraftComposerThreadIdRef = useRef<string | null>(null);
  const threadPaneTimelineActionHandlersRef = useRef(new Set<ThreadPaneTimelineActionHandler>());
  const draftComposerTransitionOriginRef = useRef<DOMRect | null>(null);
  const [draftComposerTransitionToken, setDraftComposerTransitionToken] = useState(0);
  const [isDraftComposerTransitioning, setIsDraftComposerTransitioning] = useState(false);
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
    handleShowWorkspace,
    handleSelectAutomations,
    handleSelectChatThread,
    handleSelectSectionThread,
    handleSelectProjectSettings,
    handleSelectThread,
    mobilePanel,
    routeSelectedThread,
    routeSelectedThreadRef,
    routeThreadPaneId,
    selectMaterializedThread,
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
    onSelectThread: handleThreadSelectionRead,
    chatThreadsRef,
    initialRoute,
    sectionThreadsRef,
    resetComposerDraft,
    threadsByProjectIdRef,
  });

  const {
    cachedSidebarSnapshotData,
    scopedSidebarQueriesEnabled,
    scopedSidebarSnapshotStaleTime,
    sidebarThreadsQuery,
  } = useSidebarThreadsSnapshot({
    queryClient: queryClientForShell,
    routeSelectedThreadRef,
    selectedThreadIdRef,
    onChatThreadsCursorChange: setChatThreadsNextCursor,
    onProjectThreadCursorsChange: setProjectThreadNextCursors,
  });
  const projectsQuery = useQuery({
    enabled: scopedSidebarQueriesEnabled,
    queryKey: queryKeys.projects,
    refetchOnMount: false,
    staleTime: scopedSidebarSnapshotStaleTime,
    queryFn: async ({ signal }) => {
      const seededProjects = cachedSidebarSnapshotData<Project[]>(queryKeys.projects);
      if (seededProjects) {
        return seededProjects;
      }
      return listProjects(signal);
    },
  });
  const capabilitiesQuery = useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: ({ signal }) => getCapabilities(signal),
    staleTime: Infinity,
  });
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const orderedProjects = projects;
  const projectThreadQueries = useQueries({
    queries: orderedProjects.map((project) => ({
      enabled: scopedSidebarQueriesEnabled,
      queryKey: queryKeys.projectThreads(project.id),
      refetchOnMount: false,
      staleTime: scopedSidebarSnapshotStaleTime,
      queryFn: async ({ signal }) => {
        const seededThreads = cachedSidebarSnapshotData<ThreadSummary[]>(queryKeys.projectThreads(project.id));
        if (seededThreads) {
          return seededThreads;
        }
        const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(project.id));
        const response = await listThreadsPage(project.id, { signal });
        signal.throwIfAborted();
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
    queryFn: async ({ signal }) => {
      const seededThreads = cachedSidebarSnapshotData<ThreadSummary[]>(queryKeys.chatThreads);
      if (seededThreads) {
        return seededThreads;
      }
      const beforeSnapshot = queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads);
      const response = await listChatThreadsPage({ signal });
      signal.throwIfAborted();
      setChatThreadsNextCursor(response.nextCursor ?? null);
      return mergeChatThreadData(
        queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads),
        response.threads,
        beforeSnapshot,
      );
    },
  });
  const nativeSections = useThreadSections(sidebarThreadsQuery.data, {
    snapshotUpdatedAt: sidebarThreadsQuery.dataUpdatedAt,
    onChanged: () => publishThreadPaneTimelineAction({ kind: "refresh_snapshot" }),
    onError: reportError,
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
  const { usageLimitSnapshot, applyUsageLimitSnapshot } = useUsageLimits();
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
  const archiveThreadMutation = useMutation({ mutationFn: archiveThread });
  const renameThreadMutation = useMutation({
    mutationFn: ({ threadId, name }: { threadId: string; name: string }) => renameThread(threadId, name),
    onSuccess: (thread) => replaceThread(thread),
  });
  const threadNotificationsMutation = useMutation({
    mutationFn: ({ threadId, enabled }: { threadId: string; enabled: boolean }) =>
      setThreadNotificationsEnabled(threadId, enabled),
  });
  const chatThreads = chatThreadsQuery.data ?? EMPTY_THREADS;
  const sectionThreads = nativeSections.threads;
  const flatProjectThreads = useMemo(() => Object.values(threadsByProjectId).flat(), [threadsByProjectId]);
  const selectedProjectPane =
    selectedProjectPaneId ? orderedProjects.find((project) => project.id === selectedProjectPaneId) ?? null : null;
  const threadSummariesById = useMemo(() => {
    const summaries: Record<string, ThreadSummary> = {};
    for (const thread of [...chatThreads, ...sectionThreads, ...flatProjectThreads]) {
      summaries[thread.id] = thread;
    }
    if (routeSelectedThread) {
      const listed = summaries[routeSelectedThread.id];
      summaries[routeSelectedThread.id] = listed
        ? { ...routeSelectedThread, projectId: listed.projectId }
        : routeSelectedThread;
    }
    return summaries;
  }, [chatThreads, flatProjectThreads, sectionThreads, routeSelectedThread]);
  const threadProjectIdsById = useMemo(() => {
    const projectIds: Record<string, string> = {};
    for (const thread of Object.values(threadSummariesById)) {
      if (thread.projectId) projectIds[thread.id] = thread.projectId;
    }
    return projectIds;
  }, [threadSummariesById]);
  const isSelectedThreadSnapshotDeferred =
    selectedThreadId !== null && materializingThreadIds.has(selectedThreadId);
  const isDraftThreadSelected =
    draftChatThreadSelected || (draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId);
  const subagents = useThreadSubagents(selectedMainPane === "thread" ? selectedThreadId : null);
  const automations = automationsQuery.data ?? EMPTY_AUTOMATIONS;
  const automationTargetThreadOptions = useMemo(
    () =>
      automationThreadOptions({
        chatThreads,
        sectionThreads,
        projectThreads: flatProjectThreads,
      }),
    [chatThreads, flatProjectThreads, sectionThreads],
  );
  const {
    approvals,
    handleApprovalDecision,
  } = useApprovalsState({ onError: reportError });
  approvalsRef.current = approvals;
  chatThreadsRef.current = chatThreads;
  sectionThreadsRef.current = sectionThreads;
  pendingTitleThreadIdsRef.current = pendingTitleThreadIds;
  threadsByProjectIdRef.current = threadsByProjectId;
  const { account, handleLogout } = useAccountSession({ onError: reportError });
  const {
    applyThreadNotificationsState,
    applyThreadUpsert,
    patchThreadEverywhere,
    refreshSidebarThreadsForLiveEvent,
    replaceThread,
  } = useSidebarThreadCaches({
    chatThreadsRef,
    sectionThreadsRef,
    queryClient: queryClientForShell,
    routeSelectedThreadRef,
    selectedThreadIdRef,
    setPendingTitleThreadIds,
    setRouteSelectedThreadState,
    threadsByProjectIdRef,
  });
  const { composerDefaults, hydrateComposerDefaults, models } = useComposerSettingsState({
    onError: reportError,
    projects,
  });
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
    sectionThreads,
    updateThreadEverywhere: patchThreadEverywhere,
  });
  useThreadViewPresence({
    enabled: selectedMainPane === "thread",
    threadIds: visibleThreadIds,
  });
  useKodexNotifications({
    chatThreads,
    sectionThreads,
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
      ...sectionThreads,
      ...Object.values(threadsByProjectId).flat(),
    ];
    setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, loadedThreads));
  }, [chatThreads, sectionThreads, threadsByProjectId]);

  useEffect(() => {
    const selectedId = selectedThreadIdRef.current;
    if (!selectedId || selectedProjectIdRef.current) {
      return;
    }
    for (const [projectId, projectThreads] of Object.entries(threadsByProjectId)) {
      if (projectThreads.some((thread) => thread.id === selectedId)) {
        selectedProjectIdRef.current = projectId;
        setSelectedProjectId(projectId);
        return;
      }
    }
  }, [threadsByProjectId]);

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

  const { liveRouteHandlers } = useLiveEventHandlers({
    applyCompletedAgentTurnEvent,
    applyQueuedInputDeleted: removeQueuedInput,
    applyQueuedInputUpsert: upsertQueuedInput,
    applyThreadMetadataEvent,
    applyThreadNotificationsState,
    applyThreadReadStateEvent,
    applyThreadUpsert,
    applyUsageLimitSnapshot,
    queryClient: queryClientForShell,
    refreshSidebarThreadsForLiveEvent,
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

  function handleMoveProject(projectId: string, beforeProjectId: string | null) {
    void moveProject(projectId, beforeProjectId).then(() => refreshProjectState(queryClientForShell)).catch(reportError);
  }

  async function createDraftThreadFromComposer({
    composerSettings: paneComposerSettings,
    firstMessageText,
    projectId,
    cwd,
  }: {
    composerSettings?: ComposerSettings;
    firstMessageText: string;
    projectId?: string;
    cwd?: string;
  }) {
    draftComposerTransitionOriginRef.current = composerShellRef.current?.getBoundingClientRect() ?? null;
    const threadSettings = paneComposerSettings ?? composerDefaults;
    const thread = optimisticThreadSummary(
      projectId
        ? await createThread(projectId, { ...createThreadOptions(threadSettings), cwd })
        : await createChatThread(firstMessageText, createThreadOptions(threadSettings)),
      firstMessageText,
    );
    void refreshProjectState(queryClientForShell);
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
    return { threadId: thread.id };
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

  function handleThreadSelectionRead(threadId: string) {
    markCompletedAgentTurnSeen(threadId);
  }

  function handleSelectedThreadSnapshot(thread: ThreadSummary) {
    if (thread.id === selectedThreadIdRef.current) {
      setRouteSelectedThreadState(thread);
      setSelectedProjectId(thread.projectId ?? null);
      setUnavailableThreadId((current) => (current === thread.id ? null : current));
    }
    replaceThread(thread);
  }

  function handleSelectedThreadLoadFailed(threadId: string) {
    if (threadId !== selectedThreadIdRef.current) {
      return;
    }
    setRouteSelectedThreadState(null);
    setUnavailableThreadId(threadId);
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
    handleSelectedThreadSnapshot(thread);
  });
  const handleThreadPaneSnapshotLoadFailed = useEventCallback((threadId: string) => {
    handleSelectedThreadLoadFailed(threadId);
  });
  const handleClosePreferences = useEventCallback(() => setPreferencesOpen(false));
  const handleOpenPreferences = useEventCallback(() => setPreferencesOpen(true));
  const stableHandleCreateChat = useEventCallback(handleCreateChat);
  const stableHandleCreateThread = useEventCallback(handleCreateThread);
  const stableHandlePinThread = useEventCallback((threadId: string) => nativeSections.moveThread(threadId, PINNED_SECTION_ID));
  const stableHandleRenameThread = useEventCallback((threadId: string, name: string) =>
    handleRenameThread(threadId, name),
  );
  const stableHandleSetThreadNotificationsEnabled = useEventCallback((threadId: string, enabled: boolean) =>
    void handleSetThreadNotificationsEnabled(threadId, enabled),
  );
  const stableHandleSelectAutomations = useEventCallback(handleSelectAutomations);
  const stableHandleSelectProjectSettings = useEventCallback(handleSelectProjectSettings);
  const stableHandleSelectChatThread = useEventCallback(handleSelectChatThread);
  const stableHandleSelectSectionThread = useEventCallback(handleSelectSectionThread);
  const stableHandleSelectThread = useEventCallback(handleSelectThread);
  const stableHandleUnpinThread = useEventCallback((threadId: string) => nativeSections.moveThread(threadId, null));
  const workspaceThreadActions = useMemo(
    () => ({
      onArchiveThread: handleArchiveThreadById,
      onPinThread: stableHandlePinThread,
      onRenameThread: stableHandleRenameThread,
      onSetThreadNotificationsEnabled: stableHandleSetThreadNotificationsEnabled,
      onUnpinThread: stableHandleUnpinThread,
      sections: nativeSections.sections,
      onMoveThreadToSection: nativeSections.moveThread,
      sectionMovePending: nativeSections.isMoving,
    }),
    [
      handleArchiveThreadById,
      nativeSections.sections,
      nativeSections.moveThread,
      nativeSections.isMoving,
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
      const response = await queryClientForShell.fetchQuery({
        queryKey: [...queryKeys.threadPages, "chat", cursor],
        queryFn: ({ signal }) => listChatThreadsPage({ cursor, signal }),
        staleTime: 0,
      });
      queryClientForShell.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
        appendThreadPage(current, response.threads),
      );
      setChatThreadsNextCursor(response.nextCursor ?? null);
      setChatThreadsPaginationState("idle");
    } catch (error) {
      if (isCancelledError(error)) { setChatThreadsPaginationState("idle"); return; }
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
      const response = await queryClientForShell.fetchQuery({
        queryKey: [...queryKeys.threadPages, "project", projectId, cursor],
        queryFn: ({ signal }) => listThreadsPage(projectId, { cursor, signal }),
        staleTime: 0,
      });
      queryClientForShell.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), (current) => appendThreadPage(current, response.threads));
      setProjectThreadNextCursors((current) => ({ ...current, [projectId]: response.nextCursor ?? null }));
      setProjectThreadPaginationStateById((current) => ({ ...current, [projectId]: "idle" }));
    } catch (error) {
      if (isCancelledError(error)) { setProjectThreadPaginationStateById((current) => ({ ...current, [projectId]: "idle" })); return; }
      setProjectThreadPaginationStateById((current) => ({ ...current, [projectId]: "error" }));
      reportError(error);
    } finally {
      if (projectThreadLoadingCursorsRef.current[projectId] === cursor) {
        const { [projectId]: _finishedCursor, ...remaining } = projectThreadLoadingCursorsRef.current;
        projectThreadLoadingCursorsRef.current = remaining;
      }
    }
  });
  const sidebarDataState = useMemo(
    () => ({
      chatThreads: scopedSidebarQueriesEnabled ? queryResultLoadState(chatThreadsQuery) : queryResultLoadState(sidebarThreadsQuery),
      sections: queryResultLoadState(sidebarThreadsQuery),
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
      projectThreadQueries,
      projectsQuery,
      scopedSidebarQueriesEnabled,
      sidebarThreadsQuery,
    ],
  );
  const subagentViewer = subagents.open ? (
    <Suspense fallback={null}>
      <SubagentThreadViewer
        imagePreviewUrlsByPath={mergedImagePreviewUrlsByPath}
        onError={reportError}
        onImageOpen={setLightboxImage}
        onMarkdownOpen={setMarkdownPreview}
        onSelectSubagent={subagents.select}
        selectedSubagentId={subagents.selectedId}
        showDebugEvents={showDebugEvents}
        subagents={subagents.subagents}
        hasMore={subagents.hasMore}
        loadingMore={subagents.loadingMore}
        onLoadMore={subagents.loadMore}
        error={subagents.error}
        onReload={subagents.reload}
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
  const renderWorkspaceThreadComposer = useCallback(
    (pane: WorkspacePane, paneState: ThreadComposerState) => (
      <ThreadPaneComposerBridge
        composerDefaults={composerDefaults}
        contextUsageByThreadId={contextUsageByThreadId}
        composerDraftStore={composerDraftStoreRef.current}
        hydrateComposerDefaults={hydrateComposerDefaults}
        isDraftComposerTransitioning={isDraftComposerTransitioning}
        models={models}
        onCreateDraftThread={createDraftThreadFromComposer}
        onError={reportError}
        onImageOpen={setLightboxImage}
        onImagePreviewUrlsChanged={handlePaneImagePreviewUrlsChanged}
        onQueuedInputDeleted={removeQueuedInput}
        onQueuedInputUpsert={upsertQueuedInput}
        onThreadMaterialized={markThreadMaterialized}
        onThreadTurnStartFailed={markThreadIdle}
        onThreadTurnStarted={markThreadActive}
        pane={pane}
        paneState={paneState}
        projects={orderedProjects}
        skillsInvalidationGeneration={skillsInvalidationGeneration}
      />
    ),
    [
      composerDefaults,
      contextUsageByThreadId,
      createDraftThreadFromComposer,
      handlePaneImagePreviewUrlsChanged,
      hydrateComposerDefaults,
      isDraftComposerTransitioning,
      markThreadActive,
      markThreadIdle,
      markThreadMaterialized,
      models,
      orderedProjects,
      removeQueuedInput,
      reportError,
      skillsInvalidationGeneration,
      upsertQueuedInput,
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
    (_pane, state) => (
      <Group gap="xs" wrap="nowrap">
        <ThreadProjectSelect threadId={state.thread.id} projectId={state.thread.projectId ?? null} projects={orderedProjects} onError={reportError} />
        {state.isActive && state.thread.id === selectedThreadId && (subagents.open || subagents.subagents.length > 0 || subagents.error !== null) ? (
          <AdaptiveIconButton
            aria-pressed={subagents.open ? "true" : "false"}
            label={subagents.open ? "Hide subagents" : "Show subagents"}
            onClick={subagents.toggle}
            variant={subagents.open ? "light" : "subtle"}
          ><Bot /></AdaptiveIconButton>
        ) : null}
      </Group>
    ),
    [orderedProjects, reportError, selectedThreadId, subagents.error, subagents.open, subagents.subagents.length, subagents.toggle],
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
          projects: orderedProjects,
          onDeleted: handleCreateChat,
        }}
          sidebarCollapsed={sidebarCollapsed}
          useSingleThreadWorkspace={useSingleThreadWorkspace}
          workspaceSidebarProps={{
          account, approvals, chatThreads, dataState: sidebarDataState, hoveredThreadActionId,
          chatThreadsHasMore: chatThreadsNextCursor !== null,
          chatThreadsPaginationState,
          onArchiveThread: handleArchiveThreadById,
          onCreateChat: stableHandleCreateChat, onCreateProject: () => setProjectFormOpen(true), onCreateThread: stableHandleCreateThread, onLogout: handleLogout,
          onLoadMoreChatThreads: handleLoadMoreChatThreads, onLoadMoreProjectThreads: handleLoadMoreProjectThreads,
          onPinThread: stableHandlePinThread,
          onOpenPreferences: handleOpenPreferences, onOpenTerminal: gatewayTerminalAvailable ? handleShowWorkspace : undefined,
          onMoveProject: handleMoveProject, onSelectChatThread: stableHandleSelectChatThread,
          onSelectAutomations: stableHandleSelectAutomations, onSelectSectionThread: stableHandleSelectSectionThread, onSelectProjectSettings: stableHandleSelectProjectSettings, onSelectThread: stableHandleSelectThread, onUnpinThread: stableHandleUnpinThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onSidebarCollapseClick: handleSidebarCollapseClick,
          onSidebarExpandClick: handleSidebarExpandClick, onThreadActionHoverChange: setHoveredThreadActionId,
          sectionThreads,
          onSectionsChanged: () => publishThreadPaneTimelineAction({ kind: "refresh_snapshot" }),
          sections: nativeSections.sections, sectionThreadsById: nativeSections.threadsBySectionId,
          sectionThreadHasMoreById: nativeSections.hasMoreById, sectionThreadPaginationStateById: nativeSections.paginationStates,
          onLoadMoreSectionThreads: nativeSections.loadMore, onMoveThreadToSection: nativeSections.moveThread, sectionMovePending: nativeSections.isMoving,
          pendingTitleThreadIds,
          projectThreadHasMoreById: Object.fromEntries(Object.entries(projectThreadNextCursors).map(([projectId, cursor]) => [projectId, cursor !== null])),
          projectThreadPaginationStateById,
          projects: orderedProjects, selectedMainPane, selectedProjectId, selectedThreadId: selectedMainPane === "thread" ? selectedThreadId : null,
          showDebugEvents, sidebarWidth, threadsByProjectId, usageLimitLines,
        }}
        workspaceSelectedThreadPaneId={
          selectedMainPane === "thread" && !isSelectedThreadSnapshotDeferred ? routeThreadPaneId ?? unavailableThreadId : null
        }
        />
        {projectFormOpen ? <WorkspaceProjectCreateDialog onClose={() => setProjectFormOpen(false)} onCreated={(project) => handleCreateThread(project.id)} onError={reportError} /> : null}
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
