import { MantineProvider } from "@mantine/core";
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
  createChatThread,
  createProject,
  createThread,
  listQueuedInputs,
  listThreads,
  resumeThread,
  type Approval,
  type EventEnvelope,
  type Project,
  type QueuedInput,
  type RateLimitSnapshot,
  type ThreadSummary,
} from "./api/client";
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
import { idleTimelineEntry, type TimelineEntry } from "./timeline/entry";
import { useSelectedThreadTimeline } from "./timeline/useSelectedThreadTimeline";
import {
  clearAvailableThreadTitles,
  markThreadTitlePending,
  optimisticThreadSummary,
  prependThreadForProject,
  removeThreadFromList,
  removeThreadFromProjects,
  replaceThreadInList,
  replaceThreadInProjects,
  threadDisplayTitle,
  threadHasDisplayTitle,
  updateThreadReadStateInList,
  updateThreadReadStateInProjects,
  type ThreadsByProjectId,
} from "./threads/helpers";
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
import { loadInitialKodexState } from "./shell/initialLoad";
import { KodexShellView } from "./shell/KodexShellView";
import type { MobilePanel } from "./shell/KodexShellView";
import { emptyPath, parseKodexLocation, threadPath, type KodexRoute } from "./shell/navigation";
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

  return (
    <MantineProvider forceColorScheme={colorScheme.mode} theme={theme}>
      <KodexShell colorSchemeId={colorSchemeId} onColorSchemeChange={setColorSchemeId} />
    </MantineProvider>
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [chatThreads, setChatThreads] = useState<ThreadSummary[]>([]);
  const [projectOrderIds, setProjectOrderIds] = useState<string[] | null>(() => loadSidebarProjectOrder());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadsByProjectId, setThreadsByProjectId] = useState<ThreadsByProjectId>({});
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialRoute.threadId);
  const [routeSelectedThread, setRouteSelectedThread] = useState<ThreadSummary | null>(null);
  const [unavailableThreadId, setUnavailableThreadId] = useState<string | null>(null);
  const [draftChatThreadSelected, setDraftChatThreadSelected] = useState(initialRoute.threadId === null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [queuedInputsByThreadId, setQueuedInputsByThreadId] = useState<Record<string, QueuedInput[]>>({});
  const [timelineEntry, setTimelineEntry] = useState<TimelineEntry>(idleTimelineEntry);
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
  const [usageLimitSnapshot, setUsageLimitSnapshot] = useState<RateLimitSnapshot | null>(null);
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const queueRevisionByThreadIdRef = useRef<Record<string, number>>({});
  const approvalsRef = useRef<Approval[]>([]);
  const attachedThreadIdsRef = useRef<Set<string>>(new Set());
  const attachingThreadIdsRef = useRef<Set<string>>(new Set());
  const chatThreadsRef = useRef<ThreadSummary[]>([]);
  const routeSelectedThreadRef = useRef<ThreadSummary | null>(null);
  const pendingTitleThreadIdsRef = useRef<Set<string>>(new Set());
  const threadsByProjectIdRef = useRef<ThreadsByProjectId>({});
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const directMobileDeepLinkSeededRef = useRef(false);
  const draftComposerTransitionOriginRef = useRef<DOMRect | null>(null);
  const initialPendingApprovalsReconciledRef = useRef(false);
  const liveUsageLimitSnapshotReceivedRef = useRef(false);
  const threadRequestIds = useRef<Map<string, number>>(new Map());
  const nextThreadRequestId = useRef(0);
  const [draftComposerTransitionToken, setDraftComposerTransitionToken] = useState(0);
  const [isDraftComposerTransitioning, setIsDraftComposerTransitioning] = useState(false);
  const [initialPendingApprovalsLoaded, setInitialPendingApprovalsLoaded] = useState(false);

  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? [] : [];
  const orderedProjects = useMemo(() => applySidebarProjectOrder(projects, projectOrderIds), [projectOrderIds, projects]);
  const selectedProject = selectedProjectId ? orderedProjects.find((project) => project.id === selectedProjectId) ?? null : null;
  const selectedThread =
    selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ??
    chatThreads.find((thread) => thread.id === selectedThreadId) ??
    (routeSelectedThread?.id === selectedThreadId ? routeSelectedThread : null) ??
    null;
  const selectedQueuedInputs = selectedThreadId ? queuedInputsByThreadId[selectedThreadId] ?? [] : [];
  const {
    approvals,
    applyApprovalEventWithTombstone,
    applyApprovalEventsWithTombstone,
    handleApprovalDecision,
    mergeFetchedPendingApprovals,
    selectedThreadApprovals,
    setApprovals,
  } = useApprovalsState({ selectedThreadId });
  approvalsRef.current = approvals;
  chatThreadsRef.current = chatThreads;
  pendingTitleThreadIdsRef.current = pendingTitleThreadIds;
  threadsByProjectIdRef.current = threadsByProjectId;
  const {
    account,
    handleCancelLogin,
    handleLogin,
    handleLogout,
    loginState,
    setAccount,
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
    setChatThreads,
    setThreadsByProjectId,
    threadsByProjectId,
  });
  const {
    applyThreadMetadataEvent,
    applyThreadMetadataEvents,
    selectedContextUsage,
  } = useThreadMetadata({
    selectedThreadId,
    setChatThreads,
    setPendingTitleThreadIds,
    setThreadsByProjectId,
  });
  const {
    handleSidebarResizeKeyDown,
    handleSidebarResizePointerDown,
    isSidebarResizing,
    sidebarWidth,
  } = useSidebarResize();
  const selectedTimelineEntry =
    selectedThread !== null && timelineEntry.threadId === selectedThread.id ? timelineEntry : idleTimelineEntry;
  const isSelectedThreadSnapshotDeferred =
    selectedThreadId !== null && materializingThreadIds.has(selectedThreadId);
  const isSelectedThreadNotLoaded = selectedThread?.status === "notLoaded";
  const isSelectedTimelineLoading = selectedTimelineEntry.phase === "loadingSnapshot";
  const isSelectedTimelineReady =
    selectedTimelineEntry.phase === "streamingLive" || selectedTimelineEntry.phase === "refreshingSnapshot";
  const activeSelectedTurnId = selectedThread !== null ? timeline.activeTurnId : null;
  const isDraftThreadSelected =
    draftChatThreadSelected || (draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId);
  const canCompose = selectedThread !== null || isDraftThreadSelected;
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
    setTimeline,
  });
  const selectedThreadTitle = selectedThread
    ? pendingTitleThreadIds.has(selectedThread.id)
      ? NEW_THREAD_TITLE
      : threadDisplayTitle(selectedThread)
    : NEW_THREAD_TITLE;
  const usageLimitLines = useMemo(() => formatUsageLimitLines(usageLimitSnapshot), [usageLimitSnapshot]);

  useEffect(() => {
    void loadInitialKodexState({
      hydrateComposerDefaults,
      loadProjectThreads,
      mergePendingApprovals: (nextApprovals) => {
        mergeFetchedPendingApprovals(nextApprovals);
        setInitialPendingApprovalsLoaded(true);
      },
      onChatThreadsLoaded: (nextThreads) => {
        const hydratedThreads = mergeRouteSelectedThreadIntoList(
          nextThreads,
          routeSelectedThreadRef.current,
          selectedThreadIdRef.current,
        );
        setChatThreads((current) => mergeLoadedChatThreads(current, hydratedThreads));
        setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, hydratedThreads));
      },
      onError: reportError,
      onProjectsLoaded: (nextProjects) => {
        setProjects(nextProjects);
      },
      setAccount,
      setRateLimits: (rateLimits) => {
        if (!liveUsageLimitSnapshotReceivedRef.current) {
          setUsageLimitSnapshot(usageLimitSnapshotFromResponse(rateLimits));
        }
      },
    });
  }, []);

  useEffect(() => {
    if (!initialPendingApprovalsLoaded || initialPendingApprovalsReconciledRef.current) {
      return;
    }
    initialPendingApprovalsReconciledRef.current = true;
  }, [approvals, initialPendingApprovalsLoaded]);

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
        applyQueueEvent(event);
        applyThreadMetadataEvent(event);
        applyCompletedAgentTurnEvent(event);
        const nextUsageLimitSnapshot = usageLimitSnapshotFromEvent(event);
        if (nextUsageLimitSnapshot) {
          liveUsageLimitSnapshotReceivedRef.current = true;
          setUsageLimitSnapshot(nextUsageLimitSnapshot);
        }
        if (isApprovalEvent(event)) {
          setApprovals((current) => applyApprovalEventWithTombstone(current, event));
        }
      },
    });
    client.connect();
    return client.close;
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }
    let cancelled = false;
    const threadId = selectedThreadId;
    const loadRevision = queueRevisionByThreadIdRef.current[threadId] ?? 0;
    listQueuedInputs(threadId)
      .then((queuedInputs) => {
        if (cancelled || (queueRevisionByThreadIdRef.current[threadId] ?? 0) !== loadRevision) {
          return;
        }
        setQueuedInputsByThreadId((current) => ({
          ...current,
          [threadId]: [...queuedInputs].sort(compareQueuedInputs),
        }));
      })
      .catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

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

  async function loadProjectThreads(projectId: string) {
    const requestId = nextThreadRequestId.current + 1;
    nextThreadRequestId.current = requestId;
    threadRequestIds.current.set(projectId, requestId);

    try {
      const nextThreads = mergeRouteSelectedThreadIntoList(
        await listThreads(projectId),
        routeSelectedThreadRef.current,
        selectedThreadIdRef.current,
      );
      if (threadRequestIds.current.get(projectId) !== requestId) {
        return;
      }

      setThreadsByProjectId((current) => ({ ...current, [projectId]: nextThreads }));
      setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, nextThreads));
      const selectedId = selectedThreadIdRef.current;
      if (selectedId && nextThreads.some((thread) => thread.id === selectedId)) {
        selectedProjectIdRef.current = projectId;
        setSelectedProjectId(projectId);
        void hydrateComposerDefaults(projectId);
      }
    } catch (error) {
      if (threadRequestIds.current.get(projectId) === requestId) {
        reportError(error);
      }
    }
  }

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
      const project = await createProject({
        ...(options.createDirectory ? { createDirectory: true } : {}),
        cwd,
      });
      setProjects((current) => [project, ...current]);
      setThreadsByProjectId((current) => ({ ...current, [project.id]: [] }));
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
    setDraftThreadProjectId(null);
    clearTimelineEntry();
    if (!threadsByProjectId[projectId]) {
      void loadProjectThreads(projectId);
    }
  }

  function handleCreateThread(projectId: string) {
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
    if (!threadsByProjectId[projectId]) {
      void loadProjectThreads(projectId);
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
      setThreadsByProjectId((current) => prependThreadForProject(current, projectId, thread));
    } else {
      setChatThreads((current) => [thread, ...current]);
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
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, threadId, (thread) =>
        thread.status === "active" ? {} : { status: "active" },
      ),
    );
    setChatThreads((current) =>
      updateThreadReadStateInList(current, threadId, (thread) =>
        thread.status === "active" ? {} : { status: "active" },
      ),
    );
  }

  function markThreadIdle(threadId: string) {
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, threadId, (thread) =>
        thread.status === "idle" ? {} : { status: "idle" },
      ),
    );
    setChatThreads((current) =>
      updateThreadReadStateInList(current, threadId, (thread) =>
        thread.status === "idle" ? {} : { status: "idle" },
      ),
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

  function selectKnownProjectThread(projectId: string, threadId: string) {
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

  function selectRouteThread(threadId: string) {
    const knownSelection = findKnownThreadSelection(threadId);
    if (knownSelection?.kind === "project") {
      selectKnownProjectThread(knownSelection.projectId, threadId);
      return;
    }
    if (knownSelection?.kind === "chat") {
      selectKnownChatThread(threadId);
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

  function findKnownThreadSelection(threadId: string): { kind: "chat" } | { kind: "project"; projectId: string } | null {
    for (const [projectId, threads] of Object.entries(threadsByProjectIdRef.current)) {
      if (threads.some((thread) => thread.id === threadId)) {
        return { kind: "project", projectId };
      }
    }
    if (chatThreadsRef.current.some((thread) => thread.id === threadId)) {
      return { kind: "chat" };
    }
    return null;
  }

  async function handleArchiveThread(threadId = selectedThreadId) {
    if (!threadId) {
      return;
    }
    await archiveThread(threadId);
    attachedThreadIdsRef.current.delete(threadId);
    attachingThreadIdsRef.current.delete(threadId);
    setThreadsByProjectId((current) => removeThreadFromProjects(current, threadId));
    setChatThreads((current) => removeThreadFromList(current, threadId));
    if (threadId === selectedThreadId) {
      clearTimelineEntry();
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
      setRouteSelectedThreadState(null);
      setUnavailableThreadId(null);
      replaceKodexRoute({ panel: null, threadId: null });
    }
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

  function replaceThread(thread: ThreadSummary) {
    setThreadsByProjectId((current) => replaceThreadInProjects(current, thread, selectedProjectId));
    setChatThreads((current) => replaceThreadInList(current, thread));
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
    bumpQueueRevision(row.threadId);
    setQueuedInputsByThreadId((current) => {
      const rows = current[row.threadId] ?? [];
      const withoutRow = rows.filter((item) => item.id !== row.id);
      return {
        ...current,
        [row.threadId]: [...withoutRow, row].sort(compareQueuedInputs),
      };
    });
  }

  function removeQueuedInput(threadId: string, id: string) {
    bumpQueueRevision(threadId);
    setQueuedInputsByThreadId((current) => ({
      ...current,
      [threadId]: (current[threadId] ?? []).filter((item) => item.id !== id),
    }));
  }

  function bumpQueueRevision(threadId: string) {
    queueRevisionByThreadIdRef.current[threadId] = (queueRevisionByThreadIdRef.current[threadId] ?? 0) + 1;
  }

  function resetComposerDraft() {
    setComposerResetToken((current) => current + 1);
  }

  function applyBrowserRoute(route: KodexRoute) {
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
    const nextPath = route.threadId ? threadPath(route.threadId, { panel: route.panel }) : emptyPath({ panel: route.panel });
    if (currentLocationPath() === nextPath) {
      return;
    }
    window.history.pushState({ kodexRoute: true }, "", nextPath);
  }

  function replaceKodexRoute(route: KodexRoute) {
    const nextPath = route.threadId ? threadPath(route.threadId, { panel: route.panel }) : emptyPath({ panel: route.panel });
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
  const stableHandleSelectChatThread = useEventCallback(handleSelectChatThread);
  const stableHandleSelectThread = useEventCallback(handleSelectThread);
  const handleShowMobileSidebar = useEventCallback(() => {
    pushKodexRoute({ panel: "threads", threadId: selectedThreadIdRef.current });
    setMobilePanel("threads");
  });
  const handleShowMobileThread = useEventCallback(() => {
    pushKodexRoute({ panel: null, threadId: selectedThreadIdRef.current });
    setMobilePanel("chat");
  });

  return (
    <>
      <KodexShellView
          composerPanelProps={{
          activeSelectedTurnId, attachmentInputRef, canCompose, composerResetToken, composerSettings, composerSettingsError,
          composerShellRef, contextUsage: selectedContextUsage, currentProjectName: selectedProject?.name ?? null,
          draftProjectSelector: isDraftThreadSelected
            ? {
                onChange: stableHandleDraftProjectChange,
                projects: orderedProjects,
                value: draftChatThreadSelected ? null : draftThreadProjectId,
              }
            : undefined,
          selectedGitBranch: selectedThread?.gitInfo?.branch ?? null, isDraftThreadSelected, isDraftComposerTransitioning, isComposerDragActive,
          isComposerSubmitting, isQueuedTurnStartPending, isSelectedTimelineReady, models,
          onAbortQueuedSteer: handleAbortQueuedSteer, onAttachmentInputChange: handleAttachmentInputChange,
          onComposerDragLeave: handleComposerDragLeave, onComposerDragOver: handleComposerDragOver, onComposerDrop: handleComposerDrop,
          onComposerKeyDown: handleComposerKeyDown, onComposerPaste: handleComposerPaste, onComposerSettingsChange: handleComposerSettingsChange,
          onImageOpen: setLightboxImage, onRemovePendingAttachment: removePendingAttachment, onStopTurn: handleStopTurn,
          onSubmitQueuedSteer: handleSubmitQueuedSteer, onSubmitTurn: handleSubmitTurn, pendingAttachments, queuedSteerRows,
          selectedThreadPresent: selectedThread !== null,
        }}
        isSidebarResizing={isSidebarResizing}
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
          onShowMobileSidebar: handleShowMobileSidebar, onTimelineReady: handleTimelineReadyForSelectedThread, pendingTitleThreadIds,
          scrollParentElement: timelineScrollElement, selectedThread, selectedThreadApprovals, selectedThreadTitle,
          selectedThreadUnavailableId: unavailableThreadId,
          selectedTimelineEntry, setTimelineScrollElement, showDebugEvents, timeline,
        }}
        workspaceSidebarProps={{
          account, approvals, chatThreads, hoveredThreadActionId, isSidebarResizing, loginState,
          onArchiveThread: handleArchiveThreadById, onCancelLogin: handleCancelLogin,
          onCreateChat: stableHandleCreateChat, onCreateProject: stableHandleCreateProject, onCreateThread: stableHandleCreateThread, onLogin: handleLogin, onLogout: handleLogout,
          onOpenPreferences: handleOpenPreferences, onProjectCwdChange: handleProjectCwdChange, onProjectDirectoryCreateCancel: () => setProjectDirectoryCreateCwd(null),
          onProjectFormOpenChange: setProjectFormOpen, onReorderProjects: handleReorderProjects, onSelectChatThread: stableHandleSelectChatThread, onSelectThread: stableHandleSelectThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onSidebarResizeKeyDown: handleSidebarResizeKeyDown,
          onSidebarResizePointerDown: handleSidebarResizePointerDown, onThreadActionHoverChange: setHoveredThreadActionId,
          pendingTitleThreadIds, projectCwd, projectDirectoryCreatePending: projectDirectoryCreateCwd === projectCwd.trim() && projectCwd.trim().length > 0,
          projectFormOpen, projects: orderedProjects, selectedProjectId, selectedThreadId,
          showDebugEvents, sidebarWidth, threadsByProjectId, usageLimitLines,
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

function compareQueuedInputs(left: QueuedInput, right: QueuedInput): number {
  const priority = (row: QueuedInput) => (row.priority === "rejectedSteer" ? 0 : 1);
  const priorityDelta = priority(left) - priority(right);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
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

function mergeLoadedChatThreads(current: ThreadSummary[], loaded: ThreadSummary[]): ThreadSummary[] {
  if (current.length === 0) {
    return loaded;
  }
  const currentIds = new Set(current.map((thread) => thread.id));
  return [...current, ...loaded.filter((thread) => !currentIds.has(thread.id))];
}

function mergeRouteSelectedThreadIntoList(
  threads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
): ThreadSummary[] {
  if (
    !routeSelectedThread ||
    routeSelectedThread.id !== selectedThreadId ||
    !threads.some((thread) => thread.id === routeSelectedThread.id)
  ) {
    return threads;
  }
  return threads.map((thread) => (thread.id === routeSelectedThread.id ? routeSelectedThread : thread));
}
