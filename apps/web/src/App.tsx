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
  createAutomation,
  createChatThread,
  createProject,
  createThread,
  deleteAutomation,
  listQueuedInputs,
  listAutomations,
  listPinnedThreads,
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
  type RateLimitSnapshot,
  type ThreadSummary,
} from "./api/client";
import { applyAutomationEvent, deleteAutomationById, mergeAutomationSnapshot, upsertAutomation } from "./automations/state";
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
  withoutPinnedProjectThreads,
  withoutPinnedThreads,
  type ThreadsByProjectId,
} from "./threads/helpers";
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
import { loadInitialKodexState } from "./shell/initialLoad";
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
  const [pinnedThreads, setPinnedThreads] = useState<ThreadSummary[]>([]);
  const [projectOrderIds, setProjectOrderIds] = useState<string[] | null>(() => loadSidebarProjectOrder());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadsByProjectId, setThreadsByProjectId] = useState<ThreadsByProjectId>({});
  const [selectedMainPane, setSelectedMainPane] = useState<"thread" | "automations">(initialRoute.view ?? "thread");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialRoute.threadId);
  const [routeSelectedThread, setRouteSelectedThread] = useState<ThreadSummary | null>(null);
  const [unavailableThreadId, setUnavailableThreadId] = useState<string | null>(null);
  const [draftChatThreadSelected, setDraftChatThreadSelected] = useState(initialRoute.threadId === null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [queuedInputsByThreadId, setQueuedInputsByThreadId] = useState<Record<string, QueuedInput[]>>({});
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationsLoaded, setAutomationsLoaded] = useState(false);
  const [automationsLoading, setAutomationsLoading] = useState(false);
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
  const [usageLimitSnapshot, setUsageLimitSnapshot] = useState<RateLimitSnapshot | null>(null);
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const [skillsInvalidationGeneration, setSkillsInvalidationGeneration] = useState(0);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const queueRevisionByThreadIdRef = useRef<Record<string, number>>({});
  const automationRevisionRef = useRef(0);
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
    pinnedThreads.find((thread) => thread.id === selectedThreadId) ??
    (routeSelectedThread?.id === selectedThreadId ? routeSelectedThread : null) ??
    null;
  const selectedQueuedInputs = selectedThreadId ? queuedInputsByThreadId[selectedThreadId] ?? [] : [];
  const flatProjectThreads = useMemo(() => Object.values(threadsByProjectId).flat(), [threadsByProjectId]);
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
    mergeFetchedPendingApprovals,
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
    setPinnedThreads,
    setThreadsByProjectId,
    threadsByProjectId,
    pinnedThreads,
  });
  const {
    applyThreadMetadataEvent,
    applyThreadMetadataEvents,
    selectedContextUsage,
  } = useThreadMetadata({
    selectedThreadId,
    setChatThreads,
    setPendingTitleThreadIds,
    setPinnedThreads,
    setThreadsByProjectId,
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
      onPinnedThreadsLoaded: (nextThreads) => {
        setPinnedThreads(nextThreads);
        setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, nextThreads));
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
        applyAutomationStreamEvent(event);
        applyQueueEvent(event);
        applyThreadPinEvent(event);
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
        if (event.kind === "skills.changed") {
          setSkillsInvalidationGeneration((current) => current + 1);
        }
      },
    });
    client.connect();
    return client.close;
  }, []);

  useEffect(() => {
    if (selectedMainPane !== "automations" || automationsLoaded || automationsLoading) {
      return;
    }
    void loadAutomationsSnapshot();
  }, [automationsLoaded, automationsLoading, selectedMainPane]);

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
      const loadedThreads = await listThreads(projectId);
      if (threadRequestIds.current.get(projectId) !== requestId) {
        return;
      }

      const selectedId = selectedThreadIdRef.current;
      const nextThreads = mergeLoadedProjectThreads(
        threadsByProjectIdRef.current[projectId] ?? [],
        loadedThreads,
        routeSelectedThreadRef.current,
        selectedId,
      );
      setThreadsByProjectId((current) => ({
        ...current,
        [projectId]: mergeLoadedProjectThreads(
          current[projectId] ?? [],
          loadedThreads,
          routeSelectedThreadRef.current,
          selectedThreadIdRef.current,
        ),
      }));
      setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, nextThreads));
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

  async function loadAutomationsSnapshot() {
    const loadRevision = automationRevisionRef.current;
    setAutomationsLoading(true);
    try {
      const snapshot = await listAutomations();
      if (automationRevisionRef.current === loadRevision) {
        setAutomations((current) =>
          mergeAutomationSnapshot(current, snapshot, loadRevision, automationRevisionRef.current),
        );
        setAutomationsLoaded(true);
      } else {
        const freshRevision = automationRevisionRef.current;
        const freshSnapshot = await listAutomations();
        if (automationRevisionRef.current === freshRevision) {
          setAutomations((current) =>
            mergeAutomationSnapshot(current, freshSnapshot, freshRevision, automationRevisionRef.current),
          );
          setAutomationsLoaded(true);
        }
      }
    } catch (error) {
      reportError(error);
    } finally {
      setAutomationsLoading(false);
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
    if (!threadsByProjectId[projectId]) {
      void loadProjectThreads(projectId);
    }
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
    setPinnedThreads((current) =>
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
    setPinnedThreads((current) =>
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
    await archiveThread(threadId);
    attachedThreadIdsRef.current.delete(threadId);
    attachingThreadIdsRef.current.delete(threadId);
    setThreadsByProjectId((current) => removeThreadFromProjects(current, threadId));
    setChatThreads((current) => removeThreadFromList(current, threadId));
    setPinnedThreads((current) => removeThreadFromList(current, threadId));
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
    automationRevisionRef.current += 1;
    setAutomations((current) => applyAutomationEvent(current, event));
  }

  async function handleCreateAutomation(request: AutomationCreateRequest) {
    const automation = await createAutomation(request);
    automationRevisionRef.current += 1;
    setAutomations((current) => upsertAutomation(current, automation));
    return automation;
  }

  async function handleUpdateAutomation(automationId: string, request: AutomationUpdateRequest) {
    const automation = await updateAutomation(automationId, request);
    automationRevisionRef.current += 1;
    setAutomations((current) => upsertAutomation(current, automation));
    return automation;
  }

  async function handlePauseAutomation(automationId: string) {
    const automation = await pauseAutomation(automationId);
    automationRevisionRef.current += 1;
    setAutomations((current) => upsertAutomation(current, automation));
    return automation;
  }

  async function handleResumeAutomation(automationId: string) {
    const automation = await resumeAutomation(automationId);
    automationRevisionRef.current += 1;
    setAutomations((current) => upsertAutomation(current, automation));
    return automation;
  }

  async function handleDeleteAutomation(automationId: string) {
    await deleteAutomation(automationId);
    automationRevisionRef.current += 1;
    setAutomations((current) => deleteAutomationById(current, automationId));
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
    setPinnedThreads((current) => {
      if (!thread.pinnedAt) {
        return removeThreadFromList(current, thread.id);
      }
      const replaced = replaceThreadInList(current, thread);
      return replaced === current ? [thread, ...current] : replaced;
    });
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
      const pinnedAt = await pinThread(threadId);
      applyThreadPinState(threadId, pinnedAt);
    } catch (error) {
      reportError(error);
    }
  }

  async function handleUnpinThread(threadId: string) {
    try {
      const pinnedAt = await unpinThread(threadId);
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
    const knownThread = findKnownThread(threadId);
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, threadId, (thread) => ({ pinnedAt })),
    );
    setChatThreads((current) => updateThreadReadStateInList(current, threadId, () => ({ pinnedAt })));
    setRouteSelectedThreadState(
      routeSelectedThreadRef.current?.id === threadId
        ? withThreadPinnedAt(routeSelectedThreadRef.current, pinnedAt)
        : routeSelectedThreadRef.current,
    );
    if (!pinnedAt) {
      setPinnedThreads((current) => removeThreadFromList(current, threadId));
      return;
    }

    if (knownThread) {
      const pinnedThread = withThreadPinnedAt(knownThread, pinnedAt);
      setPinnedThreads((current) => {
        const replaced = replaceThreadInList(current, pinnedThread);
        return replaced === current ? [pinnedThread, ...current] : replaced;
      });
      return;
    }

    void listPinnedThreads()
      .then((threads) => setPinnedThreads(threads))
      .catch(reportError);
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
  const sidebarChatThreads = useMemo(() => withoutPinnedThreads(chatThreads), [chatThreads]);
  const sidebarThreadsByProjectId = useMemo(
    () => withoutPinnedProjectThreads(threadsByProjectId),
    [threadsByProjectId],
  );

  return (
    <>
      <KodexShellView
        automationsPaneProps={{
          automations,
          defaultThreadId: selectedThreadId,
          isLoading: automationsLoading,
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
          selectedTimelineEntry, setTimelineScrollElement, showDebugEvents, timeline,
        }}
        workspaceSidebarProps={{
          account, approvals, chatThreads: sidebarChatThreads, hoveredThreadActionId, isSidebarResizing, loginState,
          onArchiveThread: handleArchiveThreadById, onCancelLogin: handleCancelLogin,
          onCreateChat: stableHandleCreateChat, onCreateProject: stableHandleCreateProject, onCreateThread: stableHandleCreateThread, onLogin: handleLogin, onLogout: handleLogout,
          onPinThread: stableHandlePinThread,
          onOpenPreferences: handleOpenPreferences, onProjectCwdChange: handleProjectCwdChange, onProjectDirectoryCreateCancel: () => setProjectDirectoryCreateCwd(null),
          onProjectFormOpenChange: setProjectFormOpen, onReorderProjects: handleReorderProjects, onSelectChatThread: stableHandleSelectChatThread,
          onSelectAutomations: stableHandleSelectAutomations, onSelectPinnedThread: stableHandleSelectPinnedThread, onSelectThread: stableHandleSelectThread, onUnpinThread: stableHandleUnpinThread,
          onShowThread: handleShowMobileThread, onShowDebugEventsChange: setShowDebugEvents, onSidebarResizeKeyDown: handleSidebarResizeKeyDown,
          onSidebarResizePointerDown: handleSidebarResizePointerDown, onThreadActionHoverChange: setHoveredThreadActionId,
          pinnedThreads,
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

function mergeLoadedProjectThreads(
  current: ThreadSummary[],
  loaded: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
): ThreadSummary[] {
  const hydratedThreads = mergeRouteSelectedThreadIntoList(loaded, routeSelectedThread, selectedThreadId);
  if (
    !routeSelectedThread ||
    routeSelectedThread.id !== selectedThreadId ||
    hydratedThreads.some((thread) => thread.id === routeSelectedThread.id) ||
    !current.some((thread) => thread.id === routeSelectedThread.id)
  ) {
    return hydratedThreads;
  }
  return [routeSelectedThread, ...hydratedThreads];
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

function withThreadPinnedAt(thread: ThreadSummary, pinnedAt: string | null): ThreadSummary {
  return { ...thread, pinnedAt };
}
