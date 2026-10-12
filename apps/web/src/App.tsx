import { ThreadDeliveryProvider } from "./timeline/ThreadDeliveryPreferences";
import { refreshUnreadBadge } from "./notifications/unreadBadge";
import { usePinnedThreads } from "./threads/usePinnedThreads";
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider, isCancelledError, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { formatUsageLimitLines } from "./account/rateLimits";
import { useAccountSession } from "./account/useAccountSession";
import { useUsageLimits } from "./account/useUsageLimits";
import {
  defaultGatewayClient,
  type Approval,
  type Automation,
  type AutomationCreateRequest,
  type AutomationUpdateRequest,
  type EventEnvelope,
  type Project,
  type ThreadSummary,
} from "./api/client";
import type { FederatedCatalog, FederatedExecutor, QualifiedCatalogRef, RegisterExecutorRequest, UpdateExecutorRequest } from "./api/federatorClient";
import { ExecutorRuntimeBoundary, ExecutorRuntimeRegistryProvider, FederatedShellRuntimeProvider, GatewayClientProvider, useExecutorConnection, useExecutorRuntimes, useGatewayClient } from "./api/GatewayClientContext";
import { queryClient, type ExecutorRuntime } from "./api/queryClient";
import { FederatedCatalogProvider, useFederatedCatalogContext } from "./federation/FederatedCatalogContext";
import { FederatedProjectCreateFlow } from "./federation/FederatedProjectCreateFlow";
import { FederatedProjectSettingsModal } from "./federation/FederatedProjectSettingsModal";
import { useFederatedSidebarController } from "./federation/useFederatedSidebarController";
import { queryKeys } from "./api/queryKeys";
import {
  deleteCachedAutomation,
  mergeAutomationData,
  upsertCachedAutomation,
} from "./automations/cache";
import { ThreadPaneComposerBridge } from "./composer/ThreadPaneComposerBridge";
import { WorkspaceProjectCreateDialog } from "./projects/ProjectCreateDialog";
import { refreshProjectState } from "./projects/cache";
import type { ComposerSettings } from "./ComposerFooterControls";
import type { ComposerDraftStore } from "./composer/useComposerDraftState";
import { automationThreadOptions } from "./automations/threadOptions";
import { createThreadOptions } from "./composer/settings";
import { singleProjectRoot } from "./projects/roots";
import { useComposerSettingsState } from "./composer/useComposerSettingsState";
import { installLiveLongTaskObserver } from "./events/liveDiagnostics";
import { routeGlobalLiveEvent } from "./events/liveRouting";
import { useLiveEventHandlers } from "./events/useLiveEventHandlers";
import type { MarkdownPreviewRequest } from "./files/types";
import type { ImageLightboxImage } from "./images/types";
import { useKodexNotifications } from "./notifications/useKodexNotifications";
import { PwaLifecycle } from "./pwa/PwaLifecycle";
import { handlePwaLiveEvent } from "./pwa/liveUpdates";
import type { PreferenceSection } from "./PreferencesModal";
import {
  applyKodexColorScheme,
  createKodexMantineTheme,
  getKodexColorScheme,
  type KodexColorSchemeId,
} from "./theme";
import { useAppearancePreferences } from "./theme/useAppearancePreferences";
import type { AppearancePreferences } from "./theme/appearancePreferences";
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
import { useSidebarThreadCaches } from "./threads/useSidebarThreadCaches";
import { useSidebarThreadsSnapshot } from "./threads/useSidebarThreadsSnapshot";
import { useThreadMetadata } from "./threads/useThreadMetadata";
import { mergeThreadReadState, preserveNewerThreadReadState } from "./threads/readState";
import { archivedThreadIdFromEvent, threadReadUpdateFromEvent, unarchivedThreadIdFromEvent } from "./threads/events";
import { useThreadViewPresence } from "./threads/useThreadViewPresence";
import { errorMessageFrom } from "./shared/values";
import { KodexShellView } from "./shell/KodexShellView";
import { useNarrowWorkspace } from "./shared/layoutBreakpoints";
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
  type VisibleThreadIdsByExecutor,
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

function ThreadViewPresenceReporters({
  enabled,
  threadIdsByExecutor,
}: {
  enabled: boolean;
  threadIdsByExecutor: VisibleThreadIdsByExecutor;
}) {
  const connection = useExecutorConnection();
  const runtimes = useExecutorRuntimes();
  return Object.entries(threadIdsByExecutor).map(([executorId, threadIds]) => {
    if (runtimes?.has(executorId)) {
      return (
        <ExecutorRuntimeBoundary executorId={executorId} key={executorId}>
          <ThreadViewPresenceReporter enabled={enabled} threadIds={threadIds} />
        </ExecutorRuntimeBoundary>
      );
    }
    return executorId === (connection?.executorId ?? "local")
      ? <ThreadViewPresenceReporter enabled={enabled} key={executorId} threadIds={threadIds} />
      : null;
  });
}

function ThreadViewPresenceReporter({ enabled, threadIds }: { enabled: boolean; threadIds: string[] }) {
  useThreadViewPresence({ enabled, threadIds });
  return null;
}

function visibleThreadGroupsEqual(a: VisibleThreadIdsByExecutor, b: VisibleThreadIdsByExecutor): boolean {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  return aEntries.length === bEntries.length && aEntries.every(([executorId, threadIds], index) => {
    const other = bEntries[index];
    return other?.[0] === executorId
      && threadIds.length === other[1].length
      && threadIds.every((threadId, threadIndex) => threadId === other[1][threadIndex]);
  });
}

type AppProps = {
  availableExecutorIds?: readonly string[];
  executorRuntime?: ExecutorRuntime;
  executorRuntimes?: readonly ExecutorRuntime[];
  federatedCatalog?: FederatedCatalog | null;
  federatedCatalogError?: string | null;
  federatedCatalogRefreshing?: boolean;
  federatedExecutors?: readonly FederatedExecutor[];
  federatedShellAvailable?: boolean;
  federatedRouteError?: string | null;
  moveFederatedCatalogItem?: (
    kind: "project" | "pinned",
    item: QualifiedCatalogRef,
    before: QualifiedCatalogRef | null,
  ) => Promise<unknown>;
  probeFederatedExecutor?: (executorId: string) => Promise<FederatedExecutor>;
  queryClientInstance?: QueryClient;
  refreshFederatedCatalog?: () => Promise<void>;
  refreshFederatedExecutors?: () => Promise<void>;
  registerFederatedExecutor?: (request: RegisterExecutorRequest) => Promise<FederatedExecutor>;
  removeFederatedExecutor?: (executorId: string) => Promise<void>;
  updateFederatedExecutor?: (executorId: string, request: UpdateExecutorRequest) => Promise<FederatedExecutor>;
  workspacePaneStore?: WorkspacePaneStoreAdapter;
};

export function App({
  availableExecutorIds,
  executorRuntime,
  executorRuntimes: providedExecutorRuntimes,
  federatedCatalog,
  federatedCatalogError = null,
  federatedCatalogRefreshing = false,
  federatedExecutors = [],
  federatedRouteError = null,
  federatedShellAvailable = true,
  moveFederatedCatalogItem,
  probeFederatedExecutor,
  queryClientInstance = queryClient,
  refreshFederatedCatalog,
  refreshFederatedExecutors,
  registerFederatedExecutor,
  removeFederatedExecutor,
  updateFederatedExecutor,
  workspacePaneStore,
}: AppProps = {}) {
  const { preferences, resolvedSchemeId: colorSchemeId, setMode, setTheme, selectTheme } = useAppearancePreferences();
  const [hasComposerTextDraft, setHasComposerTextDraft] = useState(false);
  const executorRuntimes = useMemo(
    () => providedExecutorRuntimes ?? (executorRuntime ? [executorRuntime] : []),
    [executorRuntime, providedExecutorRuntimes],
  );
  const colorScheme = useMemo(() => getKodexColorScheme(colorSchemeId), [colorSchemeId]);
  const theme = useMemo(() => createKodexMantineTheme(colorScheme), [colorScheme]);

  useLayoutEffect(() => {
    applyKodexColorScheme(document.documentElement, colorScheme);
  }, [colorScheme, colorSchemeId]);

  useEffect(() => installLiveLongTaskObserver(), []);

  const isThemeWorkbench = isThemeWorkbenchRoute();
  const content = (
    <MantineProvider forceColorScheme={colorScheme.mode} theme={theme}>
      <PwaLifecycle hasComposerTextDraft={hasComposerTextDraft} />
      {executorRuntime && (availableExecutorIds?.length ?? executorRuntimes.length) === 0 ? (
        <div
          role="alert"
          style={{
            alignItems: "center",
            background: "var(--mantine-color-body)",
            display: "flex",
            inset: 0,
            justifyContent: "center",
            padding: "var(--mantine-spacing-md)",
            position: "fixed",
            zIndex: 10000,
          }}
        >
          No executors are currently available.
        </div>
      ) : federatedRouteError ? (
        <div role="alert" style={{ position: "fixed", right: 16, top: 16, zIndex: 10000 }}>
          {federatedRouteError}
        </div>
      ) : executorRuntime && !federatedShellAvailable ? (
        <div role="status" style={{ position: "fixed", right: 16, top: 16, zIndex: 10000 }}>
          The shell executor is unavailable. Open panes on another executor remain usable.
        </div>
      ) : null}
      {isThemeWorkbench ? (
        <Suspense fallback={null}>
          <ThemeWorkbench colorSchemeId={colorSchemeId} onColorSchemeChange={selectTheme} />
        </Suspense>
      ) : (
        <KodexShell
          colorSchemeId={colorSchemeId}
          appearance={preferences}
          onAppearanceModeChange={setMode}
          onComposerTextDraftPresenceChange={setHasComposerTextDraft}
          onThemeChange={setTheme}
          workspacePaneStore={workspacePaneStore}
        />
      )}
    </MantineProvider>
  );
  const unavailableExecutorManagement = async () => { throw new Error("Executor management is unavailable."); };
  const federatedContent = federatedCatalog !== undefined && moveFederatedCatalogItem && refreshFederatedCatalog ? (
    <FederatedCatalogProvider value={{
      catalog: federatedCatalog,
      error: federatedCatalogError,
      executors: federatedExecutors,
      moveItem: moveFederatedCatalogItem,
      probeExecutor: probeFederatedExecutor ?? unavailableExecutorManagement,
      registerExecutor: registerFederatedExecutor ?? unavailableExecutorManagement,
      removeExecutor: removeFederatedExecutor ?? unavailableExecutorManagement,
      refresh: refreshFederatedCatalog,
      refreshExecutors: refreshFederatedExecutors ?? unavailableExecutorManagement,
      refreshing: federatedCatalogRefreshing,
      updateExecutor: updateFederatedExecutor ?? unavailableExecutorManagement,
    }}>
      {content}
    </FederatedCatalogProvider>
  ) : content;
  if (executorRuntime) return (
    <ExecutorRuntimeRegistryProvider availableExecutorIds={availableExecutorIds} runtimes={executorRuntimes}>
      <FederatedShellRuntimeProvider available={federatedShellAvailable} runtime={executorRuntime}>{federatedContent}</FederatedShellRuntimeProvider>
    </ExecutorRuntimeRegistryProvider>
  );
  return <QueryClientProvider client={queryClientInstance}><GatewayClientProvider client={defaultGatewayClient}>{federatedContent}</GatewayClientProvider></QueryClientProvider>;
}

function KodexShell({
  colorSchemeId,
  appearance,
  onAppearanceModeChange,
  onComposerTextDraftPresenceChange,
  onThemeChange,
  workspacePaneStore,
}: {
  colorSchemeId: KodexColorSchemeId;
  appearance: AppearancePreferences;
  onAppearanceModeChange: (mode: AppearancePreferences["mode"]) => void;
  onComposerTextDraftPresenceChange: (present: boolean) => void;
  onThemeChange: (id: KodexColorSchemeId) => void;
  workspacePaneStore?: WorkspacePaneStoreAdapter;
}) {
  const gateway = useGatewayClient();
  const federatedContext = useFederatedCatalogContext();
  const executorId = useExecutorConnection()?.executorId ?? "local";
  const [initialRoute] = useState(() => currentKodexRoute());
  const queryClientForShell = useQueryClient();
  const useSingleThreadWorkspace = useNarrowWorkspace();
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [showCommandOutputs, setShowCommandOutputs] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<{
    executorId: string;
    preview: MarkdownPreviewRequest;
    threadId: string;
  } | null>(null);
  const [paneImagePreviewUrlsByExecutor, setPaneImagePreviewUrlsByExecutor] = useState<Record<string, Record<string, string>>>({});
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferenceSection>("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [, setComposerResetToken] = useState(0);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const approvalsRef = useRef<Approval[]>([]);
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const pinnedThreadsRef = useRef<ThreadSummary[]>([]);
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
  const [visibleThreadIdsByExecutor, setVisibleThreadIdsByExecutor] = useState<VisibleThreadIdsByExecutor>({});

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
    handleSelectPinnedThread,
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
    chatThreadsRef,
    executorId,
    initialRoute,
    pinnedThreadsRef,
    resetComposerDraft,
    threadsByProjectIdRef,
  });

  const {
    cachedSidebarSnapshotData,
    scopedSidebarQueriesEnabled,
    scopedSidebarSnapshotStaleTime,
    sidebarThreadsQuery,
  } = useSidebarThreadsSnapshot({
    api: gateway,
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
      return gateway.listProjects(signal);
    },
  });
  const capabilitiesQuery = useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: ({ signal }) => gateway.getCapabilities(signal),
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
        const response = await gateway.listThreadsPage(project.id, { signal });
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
      const response = await gateway.listChatThreadsPage({ signal });
      signal.throwIfAborted();
      setChatThreadsNextCursor(response.nextCursor ?? null);
      return mergeChatThreadData(
        queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads),
        response.threads,
        beforeSnapshot,
      );
    },
  });
  const nativePinned = usePinnedThreads(sidebarThreadsQuery.data, {
    api: gateway,
    snapshotUpdatedAt: sidebarThreadsQuery.dataUpdatedAt,
    onChanged: () => publishThreadPaneTimelineAction({ executorId, kind: "refresh_snapshot" }),
    onError: reportError,
  });
  const automationsQuery = useQuery({
    enabled: selectedMainPane === "automations" && !federatedContext,
    queryKey: queryKeys.automations,
    queryFn: async () => {
      const beforeSnapshot = queryClientForShell.getQueryData<Automation[]>(queryKeys.automations);
      const snapshot = await gateway.listAutomations();
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
    mutationFn: gateway.createAutomation,
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const updateAutomationMutation = useMutation({
    mutationFn: ({ automationId, request }: { automationId: string; request: AutomationUpdateRequest }) =>
      gateway.updateAutomation(automationId, request),
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const pauseAutomationMutation = useMutation({
    mutationFn: gateway.pauseAutomation,
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const resumeAutomationMutation = useMutation({
    mutationFn: gateway.resumeAutomation,
    onSuccess: (automation) => upsertCachedAutomation(queryClientForShell, automation),
  });
  const deleteAutomationMutation = useMutation({
    mutationFn: async (automationId: string) => {
      await gateway.deleteAutomation(automationId);
      return automationId;
    },
    onSuccess: (automationId) => deleteCachedAutomation(queryClientForShell, automationId),
  });
  const archiveThreadMutation = useMutation({ mutationFn: gateway.archiveThread });
  const renameThreadMutation = useMutation({
    mutationFn: ({ threadId, name }: { threadId: string; name: string }) => gateway.renameThread(threadId, name),
    onSuccess: (thread) => replaceThread(thread),
  });
  const threadNotificationsMutation = useMutation({
    mutationFn: ({ threadId, enabled }: { threadId: string; enabled: boolean }) =>
      gateway.setThreadNotificationsEnabled(threadId, enabled),
  });
  const chatThreads = chatThreadsQuery.data ?? EMPTY_THREADS;
  const pinnedThreads = nativePinned.threads;
  const federatedSidebar = useFederatedSidebarController({
    executorId,
    moveNativePinned: nativePinned.movePinnedThread,
    moveNativeProject: handleMoveProject,
    onError: reportError,
    onShowWorkspace: handleShowWorkspace,
    setNativePinned: nativePinned.setPinned,
  });
  const federatedSidebarModel = federatedSidebar.model;
  const federatedCatalogState = federatedSidebar.federation;
  const federatedRuntimes = federatedSidebar.runtimes;
  const executorChoices = federatedSidebar.executorChoices;
  const preferredExecutorId = federatedSidebar.preferredExecutorId;
  const federationMode = federatedSidebar.federationMode;
  const sidebarProjects = federationMode ? federatedSidebarModel?.projects ?? [] : orderedProjects;
  const sidebarChatThreads = federationMode ? federatedSidebarModel?.chatThreads ?? [] : chatThreads;
  const sidebarPinnedThreads = federationMode ? federatedSidebarModel?.pinnedThreads ?? [] : pinnedThreads;
  const sidebarThreadsByProjectId = federationMode ? federatedSidebarModel?.threadsByProjectId ?? {} : threadsByProjectId;
  const flatProjectThreads = useMemo(() => Object.values(threadsByProjectId).flat(), [threadsByProjectId]);
  const selectedProjectPane =
    selectedProjectPaneId ? orderedProjects.find((project) => project.id === selectedProjectPaneId) ?? null : null;
  const threadSummariesById = useMemo(() => {
    const summaries: Record<string, ThreadSummary> = {};
    for (const thread of [...chatThreads, ...pinnedThreads, ...flatProjectThreads]) {
      summaries[thread.id] = thread;
    }
    if (routeSelectedThread) {
      const listed = summaries[routeSelectedThread.id];
      summaries[routeSelectedThread.id] = listed
        ? { ...routeSelectedThread, projectId: listed.projectId }
        : routeSelectedThread;
    }
    return summaries;
  }, [chatThreads, flatProjectThreads, pinnedThreads, routeSelectedThread]);
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
  const automations = automationsQuery.data ?? EMPTY_AUTOMATIONS;
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
    handleApprovalDecision,
  } = useApprovalsState({ onError: reportError });
  approvalsRef.current = approvals;
  chatThreadsRef.current = chatThreads;
  pinnedThreadsRef.current = pinnedThreads;
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
    pinnedThreadsRef,
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
  const applyThreadReadStateEvent = useEventCallback((event: EventEnvelope) => {
    const read = threadReadUpdateFromEvent(event);
    if (!read) return;
    patchThreadEverywhere(read.threadId, (thread) => mergeThreadReadState(thread, read));
    if (!read.readStateKnown) void refreshProjectState(queryClientForShell);
  });
  useKodexNotifications();
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
    applyThreadMetadataEvent,
    applyThreadNotificationsState,
    applyThreadReadStateEvent,
    applyThreadUpsert,
    applyUsageLimitSnapshot,
    queryClient: queryClientForShell,
    refreshSidebarThreadsForLiveEvent,
    setSkillsInvalidationGeneration,
  });

  const handleWorkspaceLiveEvent = useEventCallback((event: EventEnvelope, eventExecutorId: string) => {
    if (eventExecutorId !== executorId) return;
    handlePwaLiveEvent(event);
    const archivedThreadId = archivedThreadIdFromEvent(event);
    if (archivedThreadId) {
      handleArchivedThreadProjection(archivedThreadId, { clearSelection: false });
    } else if (unarchivedThreadIdFromEvent(event)) {
      void refreshProjectState(queryClientForShell);
    }
    routeGlobalLiveEvent(event, liveRouteHandlers);
  });
  const handleVisibleThreadIdsChange = useEventCallback((threadIdsByExecutor: VisibleThreadIdsByExecutor) => {
    setVisibleThreadIdsByExecutor((current) => visibleThreadGroupsEqual(current, threadIdsByExecutor)
      ? current
      : threadIdsByExecutor);
  });

  function handleMoveProject(projectId: string, beforeProjectId: string | null) {
    void gateway.moveProject(projectId, beforeProjectId).then(() => refreshProjectState(queryClientForShell)).catch(reportError);
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
    const threadSettings = paneComposerSettings ?? composerDefaults;
    const cwd = projectId ? singleProjectRoot(orderedProjects.find((project) => project.id === projectId)) : null;
    if (projectId && !cwd) throw new Error("Edit this project to choose one root directory before starting a chat.");
    const thread = optimisticThreadSummary(
      projectId
        ? await gateway.createThread(projectId, { ...createThreadOptions(threadSettings), cwd: cwd! })
        : await gateway.createChatThread(firstMessageText, createThreadOptions(threadSettings)),
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
    await archiveThreadMutation.mutateAsync(threadId);
    handleArchivedThreadProjection(threadId, { refillSidebar: false });
  }

  function handleArchivedThreadProjection(
    threadId: string,
    { clearSelection = true, refillSidebar = true }: { clearSelection?: boolean; refillSidebar?: boolean } = {},
  ) {
    const archivedSelectedThreadId = selectedThreadIdRef.current;
    const shouldSelectDraftAfterArchive = threadId === archivedSelectedThreadId;
    const draftProjectId = selectedProjectIdRef.current;
    void refreshUnreadBadge(queryClientForShell);
    removeThreadEverywhere(queryClientForShell, threadId);
    if (refillSidebar) {
      void refreshProjectState(queryClientForShell);
    }
    if (
      clearSelection &&
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
      const previous = routeSelectedThreadRef.current;
      setRouteSelectedThreadState(previous?.id === thread.id ? preserveNewerThreadReadState(previous, thread) : thread);
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

  function resetComposerDraft() {
    setComposerResetToken((current) => current + 1);
  }

  const handleArchiveThreadById = useEventCallback((threadId: string) => void handleArchiveThread(threadId));
  const handleSidebarArchiveThread = useEventCallback((threadId: string) => {
    federatedSidebar.archiveThread(threadId, handleArchiveThreadById);
  });
  const handleThreadArchived = useEventCallback((threadId: string) => handleArchivedThreadProjection(threadId));
  const handleCloseLightbox = useEventCallback(() => setLightboxImage(null));
  const handleCloseMarkdownPreview = useEventCallback(() => setMarkdownPreview(null));
  const handleOpenMarkdownPreview = useEventCallback((previewExecutorId: string, previewThreadId: string, preview: MarkdownPreviewRequest) => {
    setMarkdownPreview({ executorId: previewExecutorId, preview, threadId: previewThreadId });
  });
  const handleThreadPaneSnapshotLoaded = useEventCallback((thread: ThreadSummary) => {
    handleSelectedThreadSnapshot(thread);
  });
  const handleThreadPaneSnapshotLoadFailed = useEventCallback((threadId: string) => {
    handleSelectedThreadLoadFailed(threadId);
  });
  const handleClosePreferences = useEventCallback(() => setPreferencesOpen(false));
  const handleOpenPreferences = useEventCallback((section?: PreferenceSection) => {
    if (section) setPreferencesSection(section);
    setPreferencesOpen(true);
  });
  const stableHandleCreateChat = useEventCallback(handleCreateChat);
  const stableHandleCreateThread = useEventCallback(handleCreateThread);
  const stableHandlePinThread = useEventCallback((threadId: string) => nativePinned.setPinned(threadId, true));
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
  const stableHandleUnpinThread = useEventCallback((threadId: string) => nativePinned.setPinned(threadId, false));
  const workspaceThreadActions = useMemo(
    () => ({
      onArchiveThread: handleArchiveThreadById,
      onPinThread: stableHandlePinThread,
      onRenameThread: stableHandleRenameThread,
      onSetThreadNotificationsEnabled: stableHandleSetThreadNotificationsEnabled,
      onUnpinThread: stableHandleUnpinThread,
      pinPending: nativePinned.pinPending,
    }),
    [
      handleArchiveThreadById,
      nativePinned.pinPending,
      stableHandlePinThread,
      stableHandleRenameThread,
      stableHandleSetThreadNotificationsEnabled,
      stableHandleUnpinThread,
    ],
  );
  const handleShowMobileSidebar = useEventCallback(() => {
    pushKodexRoute({
      executorId,
      panel: "threads",
      projectId: selectedMainPane === "project" ? selectedProjectPaneId : null,
      threadId: null,
      view: selectedMainPane,
    });
    setMobilePanel("threads");
  });
  const handleShowMobileThread = useEventCallback(() => {
    pushKodexRoute({
      executorId,
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
        queryFn: ({ signal }) => gateway.listChatThreadsPage({ cursor, signal }),
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
        queryFn: ({ signal }) => gateway.listThreadsPage(projectId, { cursor, signal }),
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
      pinnedThreads: queryResultLoadState(sidebarThreadsQuery),
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
  const gatewayTerminalAvailable = capabilitiesQuery.data?.gateway.terminals?.enabled ?? true;
  const handlePaneImagePreviewUrlsChanged = useEventCallback((executorId: string, previewUrls: Record<string, string>) => {
    if (Object.keys(previewUrls).length === 0) {
      return;
    }
    setPaneImagePreviewUrlsByExecutor((current) => {
      let changed = false;
      const executorPreviews = current[executorId] ?? {};
      const nextExecutorPreviews = { ...executorPreviews };
      for (const [path, url] of Object.entries(previewUrls)) {
        if (nextExecutorPreviews[path] !== url) {
          nextExecutorPreviews[path] = url;
          changed = true;
        }
      }
      return changed ? { ...current, [executorId]: nextExecutorPreviews } : current;
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
        onImagePreviewUrlsChanged={(previewUrls) => handlePaneImagePreviewUrlsChanged(pane.target.executorId, previewUrls)}
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
      reportError,
      skillsInvalidationGeneration,
    ],
  );
  return (
    <ThreadDeliveryProvider includeDebugEvents={showDebugEvents} includeCommandOutputs={showCommandOutputs}>
      <WorkspaceProvider
        approvals={approvals}
        errorMessage={errorMessage}
        isVisible={selectedMainPane === "thread" && (!useSingleThreadWorkspace || mobilePanel === "chat")}
        imagePreviewUrlsByPath={imagePreviewUrlsByPath}
        imagePreviewUrlsByExecutor={paneImagePreviewUrlsByExecutor}
        onApprovalDecision={handleApprovalDecision}
        onComposerTextDraftPresenceChange={onComposerTextDraftPresenceChange}
        onFocusThreadPane={handleWorkspaceFocusThreadPane}
        onImageOpen={setLightboxImage}
        onLiveEvent={handleWorkspaceLiveEvent}
        onMarkdownOpen={handleOpenMarkdownPreview}
        onShowMobileSidebar={handleShowMobileSidebar}
        onThreadArchived={handleThreadArchived}
        onThreadSnapshotLoadFailed={handleThreadPaneSnapshotLoadFailed}
        onThreadSnapshotLoaded={handleThreadPaneSnapshotLoaded}
        onVisibleThreadIdsChange={handleVisibleThreadIdsChange}
        paneStore={workspacePaneStore}
        publishThreadPaneTimelineAction={publishThreadPaneTimelineAction}
        renderThreadComposer={renderWorkspaceThreadComposer}
        showDebugEvents={showDebugEvents}
        subscribeThreadPaneTimelineAction={subscribeThreadPaneTimelineAction}
        threadActions={workspaceThreadActions}
        threadProjectIdsById={threadProjectIdsById}
        threadSummariesById={threadSummariesById}
      >
        <ThreadViewPresenceReporters
          enabled={selectedMainPane === "thread"}
          threadIdsByExecutor={visibleThreadIdsByExecutor}
        />
        <KodexShellView
          automationsPaneProps={{
          automations,
          defaultThreadId: selectedThreadId,
          executorId,
          isLoading: automationsQuery.isLoading,
          onCreateAutomation: handleCreateAutomation,
          onDeleteAutomation: handleDeleteAutomation,
          onPauseAutomation: handlePauseAutomation,
          onResumeAutomation: handleResumeAutomation,
          onShowMobileSidebar: handleShowMobileSidebar,
          onUpdateAutomation: handleUpdateAutomation,
          preferredExecutorId,
          threadOptions: automationTargetThreadOptions,
        }}
        executorId={executorId}
        executorChoices={executorChoices}
        isDraftThreadSelected={isDraftThreadSelected}
        isSidebarResizing={isSidebarResizing}
        mainPane={selectedMainPane}
        mobilePanel={mobilePanel}
        onActivateFederatedTarget={federationMode ? federatedSidebar.activateTarget : undefined}
        onExecutorUsed={federationMode ? federatedSidebar.recordExecutorUsed : undefined}
        onSelectFederatedProject={federationMode ? federatedSidebar.selectProject : undefined}
        preferencesProps={{
          activeSection: preferencesSection, resolvedSchemeId: colorSchemeId, preferences: appearance,
          onClose: handleClosePreferences, onModeChange: onAppearanceModeChange, onThemeChange,
          onSectionChange: setPreferencesSection, opened: preferencesOpen,
        }}
        preferredExecutorId={preferredExecutorId}
        projectPaneProps={{
          onShowMobileSidebar: handleShowMobileSidebar,
          project: selectedProjectPane,
          onDeleted: handleCreateChat,
        }}
          sidebarCollapsed={sidebarCollapsed}
          useSingleThreadWorkspace={useSingleThreadWorkspace}
          workspaceSidebarProps={{
          account: federationMode ? null : account, approvals: federationMode ? [] : approvals, chatThreads: sidebarChatThreads, dataState: federationMode ? {
            chatThreads: federatedSidebarModel ? "loaded" : federatedCatalogState?.error ? "error" : "loading",
            pinnedThreads: federatedSidebarModel ? "loaded" : federatedCatalogState?.error ? "error" : "loading",
            projects: federatedSidebarModel ? "loaded" : federatedCatalogState?.error ? "error" : "loading",
            projectThreadsById: Object.fromEntries(sidebarProjects.map((project) => [project.id, "loaded"])),
          } : sidebarDataState, hoveredThreadActionId,
          itemContextById: federatedSidebarModel?.contextById,
          manageAccountInPreferences: federationMode,
          executorFilter: federatedSidebar.executorFilter,
          executorFilterOptions: federatedCatalogState?.catalog?.executors.map((entry) => ({
            label: entry.executorName,
            value: entry.executorId,
          })),
          onExecutorFilterChange: federationMode ? federatedSidebar.setExecutorFilter : undefined,
          sidebarSnapshotStatus: {
            failed: federationMode ? federatedCatalogState?.error !== null : sidebarThreadsQuery.isError,
            retrying: federationMode ? federatedCatalogState?.refreshing ?? false : sidebarThreadsQuery.isFetching,
            onRetry: () => { if (federatedCatalogState) void federatedCatalogState.refresh(); else void sidebarThreadsQuery.refetch(); },
          },
          chatThreadsHasMore: federationMode ? false : chatThreadsNextCursor !== null,
          chatThreadsPaginationState,
          onArchiveThread: federationMode ? handleSidebarArchiveThread : handleArchiveThreadById,
          onCreateChat: stableHandleCreateChat, onCreateProject: () => setProjectFormOpen(true), onCreateThread: stableHandleCreateThread, onLogout: handleLogout,
          onLoadMoreChatThreads: federationMode ? undefined : handleLoadMoreChatThreads, onLoadMoreProjectThreads: federationMode ? undefined : handleLoadMoreProjectThreads,
          onPinThread: federationMode ? (threadId) => federatedSidebar.setPinned(threadId, true) : stableHandlePinThread,
          onOpenPreferences: handleOpenPreferences, onOpenTerminal: gatewayTerminalAvailable ? handleShowWorkspace : undefined,
          onMoveProject: federationMode ? federatedSidebar.moveProject : handleMoveProject, onSelectChatThread: stableHandleSelectChatThread,
          onSelectAutomations: stableHandleSelectAutomations, onSelectPinnedThread: stableHandleSelectPinnedThread, onSelectProjectSettings: stableHandleSelectProjectSettings, onSelectThread: stableHandleSelectThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onShowCommandOutputsChange: setShowCommandOutputs, onSidebarCollapseClick: handleSidebarCollapseClick,
          onSidebarExpandClick: handleSidebarExpandClick, onThreadActionHoverChange: setHoveredThreadActionId,
          pinnedThreads: sidebarPinnedThreads,
          pinnedThreadsHasMore: federationMode ? false : nativePinned.hasMore, pinnedThreadsPaginationState: nativePinned.paginationState,
          onLoadMorePinnedThreads: federationMode ? undefined : nativePinned.loadMore, onMovePinnedThread: federationMode ? federatedSidebar.movePinned : nativePinned.movePinnedThread, pinPending: federationMode ? federatedCatalogState?.refreshing ?? false : nativePinned.pinPending,
          pendingTitleThreadIds,
          projectThreadHasMoreById: federationMode ? {} : Object.fromEntries(Object.entries(projectThreadNextCursors).map(([projectId, cursor]) => [projectId, cursor !== null])),
          projectThreadPaginationStateById,
          projects: sidebarProjects, selectedMainPane,
          selectedProjectId: federationMode ? federatedSidebar.selectedProjectKey : selectedProjectId,
          selectedThreadId: selectedMainPane === "thread"
            ? (federationMode ? federatedSidebar.selectedThreadKey : selectedThreadId)
            : null,
          showDebugEvents, showCommandOutputs, sidebarWidth, threadsByProjectId: sidebarThreadsByProjectId, usageLimitLines: federationMode ? null : usageLimitLines,
          onUnpinThread: federationMode ? (threadId) => federatedSidebar.setPinned(threadId, false) : stableHandleUnpinThread,
        }}
        resolveSidebarTarget={federatedSidebarModel?.resolveTarget}
        workspaceSelectedThreadPaneId={
          selectedMainPane === "thread" && !isSelectedThreadSnapshotDeferred ? routeThreadPaneId ?? unavailableThreadId : null
        }
        />
        {projectFormOpen ? (
          federationMode ? (
            executorChoices && federatedRuntimes ? (
              <FederatedProjectCreateFlow
                choices={executorChoices}
                onClose={() => setProjectFormOpen(false)}
                onCreated={() => federatedCatalogState?.refresh()}
                onError={reportError}
                onExecutorUsed={federatedSidebar.recordExecutorUsed}
                opened
                preferredExecutorId={preferredExecutorId}
                runtimes={federatedRuntimes}
              />
            ) : null
          ) : (
            <WorkspaceProjectCreateDialog api={gateway} onClose={() => setProjectFormOpen(false)} onCreated={(project) => handleCreateThread(project.id)} onError={reportError} />
          )
        ) : null}
        {federatedSidebar.projectSettings ? (
          <FederatedProjectSettingsModal
            actionable={federatedSidebar.projectSettingsActionable}
            executorId={federatedSidebar.projectSettings.executorId}
            onClose={federatedSidebar.closeProjectSettings}
            onRefresh={() => { void federatedCatalogState?.refresh(); }}
            project={federatedSidebar.projectSettings.project}
          />
        ) : null}
      </WorkspaceProvider>
      {lightboxImage ? (
        <Suspense fallback={null}>
          <ImageLightbox image={lightboxImage} onClose={handleCloseLightbox} />
        </Suspense>
      ) : null}
      {markdownPreview ? (
        <ExecutorRuntimeBoundary executorId={markdownPreview.executorId}>
          <Suspense fallback={null}>
            <MarkdownPreviewPane preview={markdownPreview.preview} threadId={markdownPreview.threadId} onClose={handleCloseMarkdownPreview} />
          </Suspense>
        </ExecutorRuntimeBoundary>
      ) : null}
    </ThreadDeliveryProvider>
  );
}
