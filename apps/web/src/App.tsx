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
  createAutomation,
  createChatThread,
  createProject,
  createThread,
  deleteAutomation,
  getRateLimits,
  listAutomations,
  listChatThreads,
  listQueuedInputs,
  listPinnedThreads,
  listProjects,
  listThreads,
  pauseAutomation,
  pinThread,
  resumeThread,
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
} from "./api/client";
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
import { useSelectedThreadTimeline } from "./timeline/useSelectedThreadTimeline";
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
  mergePinnedThreadData,
  mergeProjectThreadData,
  pinnedTombstonesAddedDuringSnapshot,
  removeThreadEverywhere,
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
import { threadPinUpdateFromEvent } from "./threads/events";
import {
  applySidebarProjectOrder,
  loadSidebarProjectOrder,
  saveSidebarProjectOrder,
} from "./threads/projectOrder";
import { useThreadMetadata } from "./threads/useThreadMetadata";
import { useThreadReadState } from "./threads/useThreadReadState";
import {
  createTimelineState,
  type TimelineState,
} from "./timeline/reducer";
import { errorMessageFrom } from "./shared/values";
import { KodexShellView } from "./shell/KodexShellView";
import type { MobilePanel } from "./shell/KodexShellView";
import { automationsPath, emptyPath, parseKodexLocation, threadPath, type KodexRoute } from "./shell/navigation";
import { useSidebarResize } from "./shell/useSidebarResize";
import "./App.css";

const NEW_THREAD_TITLE = "New thread";
const DRAFT_COMPOSER_TRANSITION_MS = 280;

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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedMainPane, setSelectedMainPane] = useState<"thread" | "automations">(initialRoute.view ?? "thread");
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
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(initialRoute.panel ?? "chat");
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewRequest | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<"appearance">("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const [timelineFollowLiveToken, setTimelineFollowLiveToken] = useState(0);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const approvalsRef = useRef<Approval[]>([]);
  const attachedThreadIdsRef = useRef<Set<string>>(new Set());
  const attachingThreadIdsRef = useRef<Set<string>>(new Set());
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const pinnedThreadsRef = useRef<ThreadSummary[]>([]);
  const routeSelectedThreadRef = useRef<ThreadSummary | null>(null);
  const pendingTitleThreadIdsRef = useRef<Set<string>>(new Set());
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const directMobileDeepLinkSeededRef = useRef(false);
  const draftComposerTransitionOriginRef = useRef<DOMRect | null>(null);
  const liveUsageLimitSnapshotReceivedRef = useRef(false);
  const [draftComposerTransitionToken, setDraftComposerTransitionToken] = useState(0);
  const [isDraftComposerTransitioning, setIsDraftComposerTransitioning] = useState(false);
  const [pinnedStateTrusted, setPinnedStateTrusted] = useState(false);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: listProjects,
  });
  const projects = projectsQuery.data ?? [];
  const orderedProjects = useMemo(() => applySidebarProjectOrder(projects, projectOrderIds), [projectOrderIds, projects]);
  const projectThreadQueries = useQueries({
    queries: orderedProjects.map((project) => ({
      queryKey: queryKeys.projectThreads(project.id),
      queryFn: async () =>
        mergeProjectThreadData(
          queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(project.id)),
          await listThreads(project.id),
          routeSelectedThreadRef.current,
          selectedThreadIdRef.current,
        ),
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
    queryKey: queryKeys.chatThreads,
    queryFn: async () =>
      mergeChatThreadData(
        queryClientForShell.getQueryData<ThreadSummary[]>(queryKeys.chatThreads),
        await listChatThreads(),
      ),
  });
  const pinnedThreadsQuery = useQuery({
    queryKey: queryKeys.pinnedThreads,
    queryFn: async () => {
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
  const pinThreadMutation = useMutation({ mutationFn: pinThread });
  const unpinThreadMutation = useMutation({ mutationFn: unpinThread });
  const chatThreads = chatThreadsQuery.data ?? [];
  const pinnedThreads = pinnedThreadsQuery.data ?? [];
  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? [] : [];
  const flatProjectThreads = useMemo(() => Object.values(threadsByProjectId).flat(), [threadsByProjectId]);
  const selectedProject = selectedProjectId ? orderedProjects.find((project) => project.id === selectedProjectId) ?? null : null;
  const selectedThread =
    (routeSelectedThread?.id === selectedThreadId ? routeSelectedThread : null) ??
    selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    flatProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    chatThreads.find((thread) => thread.id === selectedThreadId) ??
    pinnedThreads.find((thread) => thread.id === selectedThreadId) ??
    null;
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
  const selectedTimelineEntry =
    selectedThreadId !== null && timelineEntry.threadId === selectedThreadId ? timelineEntry : idleTimelineEntry;
  const isSelectedThreadSnapshotDeferred =
    selectedThreadId !== null && materializingThreadIds.has(selectedThreadId);
  const isSelectedThreadNotLoaded = selectedThread?.status === "notLoaded";
  const isSelectedTimelineLoading = selectedTimelineEntry.phase === "loadingSnapshot";
  const isSelectedTimelineReady =
    selectedTimelineEntry.phase === "streamingLive" || selectedTimelineEntry.phase === "refreshingSnapshot";
  const activeSelectedTurnId = selectedThread !== null ? timeline.activeTurnId : null;
  const isDraftThreadSelected =
    draftChatThreadSelected || (draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId);
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
    onThreadLocalInputSubmitted: requestSelectedThreadFollowLive,
    onThreadTurnStartFailed: markThreadIdle,
    onThreadTurnStarted: markThreadActive,
    queuedSteerRows: selectedQueuedInputs,
    selectedProjectId,
    selectedThreadId,
    setTimeline,
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
        applyThreadMetadataEvent(event);
        applyCompletedAgentTurnEvent(event);
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
      },
    });
    client.connect();
    return client.close;
  }, []);

  useSelectedThreadTimeline({
    isSelectedThreadNotLoaded,
    isSelectedThreadSnapshotDeferred,
    onApprovalEvent: applyApprovalEventWithTombstone,
    onError: reportError,
    onSnapshotThread: handleSelectedThreadSnapshot,
    onThreadMetadataEvent: applyThreadMetadataEvent,
    onQueueEvent: applyQueueEvent,
    selectedThreadId,
    setApprovals,
    setTimeline,
    setTimelineEntry,
    onThreadLoadFailed: handleSelectedThreadLoadFailed,
  });

  useEffect(() => {
    if (isSelectedThreadSnapshotDeferred) {
      return;
    }
    if (!selectedThread || !selectedThreadShouldAttachLive(selectedThread)) {
      return;
    }
    if (attachedThreadIdsRef.current.has(selectedThread.id) || attachingThreadIdsRef.current.has(selectedThread.id)) {
      return;
    }

    let cancelled = false;
    attachingThreadIdsRef.current.add(selectedThread.id);
    resumeThread(selectedThread.id)
      .then((thread) => {
        attachingThreadIdsRef.current.delete(selectedThread.id);
        attachedThreadIdsRef.current.add(thread.id);
        if (!cancelled) {
          replaceThread(thread);
        }
      })
      .catch((error) => {
        attachingThreadIdsRef.current.delete(selectedThread.id);
        if (!cancelled) {
          reportError(error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSelectedThreadSnapshotDeferred, selectedThread?.id, selectedThread?.status]);

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
    attachedThreadIdsRef.current.add(thread.id);
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
    attachedThreadIdsRef.current.add(threadId);
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
    attachedThreadIdsRef.current.delete(threadId);
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

  function requestSelectedThreadFollowLive(threadId: string) {
    if (selectedThreadIdRef.current === threadId) {
      setTimelineFollowLiveToken((current) => current + 1);
    }
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
    updateThreadEverywhere(queryClientForShell, thread.id, () => thread);
    if (thread.pinnedAt) {
      upsertPinnedThread(queryClientForShell, thread);
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

  function applyThreadPinEvent(event: EventEnvelope) {
    const update = threadPinUpdateFromEvent(event);
    if (!update) {
      return;
    }
    applyThreadPinState(update.threadId, update.pinnedAt);
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

  function reportError(error: unknown) {
    setErrorMessage(errorMessageFrom(error));
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
      return;
    }
    setSelectedMainPane("thread");
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
  const stableHandleSelectAutomations = useEventCallback(handleSelectAutomations);
  const stableHandleSelectChatThread = useEventCallback(handleSelectChatThread);
  const stableHandleSelectPinnedThread = useEventCallback(handleSelectPinnedThread);
  const stableHandleSelectThread = useEventCallback(handleSelectThread);
  const stableHandleUnpinThread = useEventCallback((threadId: string) => void handleUnpinThread(threadId));
  const handleShowMobileSidebar = useEventCallback(() => {
    pushKodexRoute({
      panel: "threads",
      threadId: selectedMainPane === "automations" ? null : selectedThreadIdRef.current,
      view: selectedMainPane,
    });
    setMobilePanel("threads");
  });
  const handleShowMobileThread = useEventCallback(() => {
    pushKodexRoute({
      panel: null,
      threadId: selectedMainPane === "automations" ? null : selectedThreadIdRef.current,
      view: selectedMainPane,
    });
    setMobilePanel("chat");
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
      chatThreads: queryResultLoadState(chatThreadsQuery),
      pinnedThreads: pinnedStateIsTrusted ? queryResultLoadState(pinnedThreadsQuery) : "loading",
      projects: queryResultLoadState(projectsQuery),
      projectThreadsById: Object.fromEntries(
        orderedProjects.map((project, index) => [
          project.id,
          queryResultLoadState(projectThreadQueries[index]),
        ]),
      ),
    }),
    [chatThreadsQuery, orderedProjects, pinnedStateIsTrusted, pinnedThreadsQuery, projectThreadQueries, projectsQuery],
  );

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
          activeSelectedTurnId, attachmentInputRef, canCompose, composerResetToken, composerSettings, composerSettingsError,
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
        sidebarWidth={sidebarWidth}
        threadPanelProps={{
          errorMessage, imagePreviewUrlsByPath, isDraftThreadSelected, isSelectedTimelineLoading,
          onArchiveThread: handleArchiveSelectedThread, onApprovalDecision: handleApprovalDecision, onImageOpen: setLightboxImage,
          onMarkdownOpen: setMarkdownPreview,
          onPinThread: stableHandlePinThread,
          onShowMobileSidebar: handleShowMobileSidebar, onTimelineReady: handleTimelineReadyForSelectedThread,
          onUnpinThread: stableHandleUnpinThread, pendingTitleThreadIds,
          scrollParentElement: timelineScrollElement, selectedThread, selectedThreadApprovals, selectedThreadTitle,
          selectedThreadUnavailableId: unavailableThreadId,
          selectedTimelineEntry, setTimelineScrollElement, showDebugEvents, timeline, timelineFollowLiveToken,
        }}
        workspaceSidebarProps={{
          account, approvals, chatThreads: sidebarChatThreads, dataState: sidebarDataState, hoveredThreadActionId, isSidebarResizing, loginState,
          onArchiveThread: handleArchiveThreadById, onCancelLogin: handleCancelLogin,
          onCreateChat: stableHandleCreateChat, onCreateProject: stableHandleCreateProject, onCreateThread: stableHandleCreateThread, onLogin: handleLogin, onLogout: handleLogout,
          onPinThread: stableHandlePinThread,
          onOpenPreferences: handleOpenPreferences, onProjectCwdChange: handleProjectCwdChange, onProjectDirectoryCreateCancel: () => setProjectDirectoryCreateCwd(null),
          onProjectFormOpenChange: setProjectFormOpen, onReorderProjects: handleReorderProjects, onSelectChatThread: stableHandleSelectChatThread,
          onSelectAutomations: stableHandleSelectAutomations, onSelectPinnedThread: stableHandleSelectPinnedThread, onSelectThread: stableHandleSelectThread, onUnpinThread: stableHandleUnpinThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onSidebarResizeKeyDown: handleSidebarResizeKeyDown,
          onSidebarResizePointerDown: handleSidebarResizePointerDown, onThreadActionHoverChange: setHoveredThreadActionId,
          pinnedThreads: sidebarPinnedThreads,
          pendingTitleThreadIds, projectCwd, projectDirectoryCreatePending: projectDirectoryCreateCwd === projectCwd.trim() && projectCwd.trim().length > 0,
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
