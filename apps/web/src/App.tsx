import { MantineProvider } from "@mantine/core";
import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isApprovalEvent } from "./approvals/state";
import { useApprovalsState } from "./approvals/useApprovalsState";
import { useAccountSession } from "./account/useAccountSession";
import {
  archiveThread,
  createProject,
  createThread,
  listThreads,
  resumeThread,
  type EventEnvelope,
  type Project,
  type ThreadSummary,
} from "./api/client";
import { createThreadOptions } from "./composer/settings";
import { useComposerSettingsState } from "./composer/useComposerSettingsState";
import { useComposerOrchestration } from "./composer/useComposerOrchestration";
import { createEventStreamClient } from "./events/stream";
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
  removeThreadFromProjects,
  replaceThreadInProjects,
  threadDisplayTitle,
  threadHasDisplayTitle,
  updateThreadReadStateInProjects,
  type ThreadsByProjectId,
} from "./threads/helpers";
import { useThreadMetadata } from "./threads/useThreadMetadata";
import { useThreadReadState } from "./threads/useThreadReadState";
import {
  createTimelineState,
  type TimelineState,
} from "./timeline/reducer";
import { errorMessageFrom } from "./shared/values";
import { loadInitialKodexState } from "./shell/initialLoad";
import { KodexShellView } from "./shell/KodexShellView";
import type { MobilePanel } from "./shell/MobilePanelSwitcher";
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadsByProjectId, setThreadsByProjectId] = useState<ThreadsByProjectId>({});
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [materializingThreadIds, setMaterializingThreadIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [timelineEntry, setTimelineEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCwd, setProjectCwd] = useState("");
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const [lightboxImage, setLightboxImage] = useState<ImageLightboxImage | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<"appearance">("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const [composerResetToken, setComposerResetToken] = useState(0);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const draftComposerTransitionOriginRef = useRef<DOMRect | null>(null);
  const threadRequestIds = useRef<Map<string, number>>(new Map());
  const nextThreadRequestId = useRef(0);
  const [draftComposerTransitionToken, setDraftComposerTransitionToken] = useState(0);
  const [isDraftComposerTransitioning, setIsDraftComposerTransitioning] = useState(false);

  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? [] : [];
  const selectedThread = selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ?? null;
  const {
    approvals,
    applyApprovalEventWithTombstone,
    applyApprovalEventsWithTombstone,
    handleApprovalDecision,
    mergeFetchedPendingApprovals,
    selectedThreadApprovals,
    setApprovals,
  } = useApprovalsState({ selectedThreadId });
  const {
    account,
    handleCancelLogin,
    handleLogin,
    handleLogout,
    loginState,
    setAccount,
  } = useAccountSession({ onError: reportError });
  const {
    applyThreadComposerSettings,
    composerSettings,
    composerSettingsError,
    draftComposerEditedRef,
    handleComposerSettingsChange,
    hydrateComposerDefaults,
    models,
  } = useComposerSettingsState({ onError: reportError, selectedThread });
  const { applyCompletedAgentTurnEvent, markCompletedAgentTurnSeen } = useThreadReadState({
    onError: reportError,
    selectedThreadIdRef,
    setThreadsByProjectId,
    threadsByProjectId,
  });
  const {
    applyThreadMetadataEvent,
    applyThreadMetadataEvents,
    selectedContextUsage,
  } = useThreadMetadata({
    selectedThreadId,
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
  const isDraftThreadSelected = draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId;
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
    pendingAttachments,
    queuedSteerRows,
    removePendingAttachment,
  } = useComposerOrchestration({
    activeSelectedTurnId,
    canCompose,
    composerSettings,
    draftThreadProjectId,
    isDraftThreadSelected,
    onCreateDraftThread: createDraftThreadFromComposer,
    onError: reportError,
    onThreadMaterialized: markThreadMaterialized,
    onThreadTurnStartFailed: markThreadIdle,
    onThreadTurnStarted: markThreadActive,
    selectedProjectId,
    selectedThreadId,
    setTimeline,
  });
  const selectedThreadTitle = selectedThread
    ? pendingTitleThreadIds.has(selectedThread.id)
      ? NEW_THREAD_TITLE
      : threadDisplayTitle(selectedThread)
    : NEW_THREAD_TITLE;

  useEffect(() => {
    void loadInitialKodexState({
      hydrateComposerDefaults,
      loadProjectThreads,
      mergePendingApprovals: mergeFetchedPendingApprovals,
      onError: reportError,
      onProjectsLoaded: (nextProjects, firstProjectId) => {
        setProjects(nextProjects);
        selectedProjectIdRef.current = firstProjectId;
        setSelectedProjectId(firstProjectId);
      },
      setAccount,
    });
  }, []);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

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
        applyThreadMetadataEvent(event);
        applyCompletedAgentTurnEvent(event);
        if (isApprovalEvent(event)) {
          setApprovals((current) => applyApprovalEventWithTombstone(current, event));
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
    selectedThreadId,
    setApprovals,
    setTimeline,
    setTimelineEntry,
  });

  useEffect(() => {
    if (!selectedThread || selectedThread.status !== "notLoaded") {
      return;
    }

    let cancelled = false;
    resumeThread(selectedThread.id)
      .then((thread) => {
        if (!cancelled) {
          replaceThread(thread);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          reportError(error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedThread?.id, selectedThread?.status]);

  async function loadProjectThreads(projectId: string, options: { selectWhenLoaded?: boolean } = {}) {
    const requestId = nextThreadRequestId.current + 1;
    nextThreadRequestId.current = requestId;
    threadRequestIds.current.set(projectId, requestId);

    try {
      const nextThreads = await listThreads(projectId);
      if (threadRequestIds.current.get(projectId) !== requestId) {
        return;
      }

      setThreadsByProjectId((current) => ({ ...current, [projectId]: nextThreads }));
      setPendingTitleThreadIds((current) => clearAvailableThreadTitles(current, nextThreads));

      if (options.selectWhenLoaded && selectedProjectIdRef.current === projectId) {
        const nextThreadId =
          selectedThreadId && nextThreads.some((thread) => thread.id === selectedThreadId)
            ? selectedThreadId
            : nextThreads[0]?.id ?? null;
        if (nextThreadId) {
          selectedThreadIdRef.current = nextThreadId;
          beginTimelineEntry(nextThreadId);
        } else {
          selectedThreadIdRef.current = null;
          clearTimelineEntry();
        }
        setSelectedThreadId(nextThreadId);
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

  async function handleCreateProject(event: FormEvent) {
    event.preventDefault();
    const project = await createProject({ name: projectName || null, cwd: projectCwd });
    setProjects((current) => [...current, project]);
    setThreadsByProjectId((current) => ({ ...current, [project.id]: [] }));
    selectProject(project.id);
    setProjectName("");
    setProjectCwd("");
    setProjectFormOpen(false);
  }

  function handleSelectProject(projectId: string) {
    if (projectId === selectedProjectId) {
      return;
    }
    selectProject(projectId);
  }

  function selectProject(projectId: string) {
    selectedProjectIdRef.current = projectId;
    if (!draftComposerEditedRef.current) {
      void hydrateComposerDefaults(projectId);
    }
    setSelectedProjectId(projectId);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setDraftThreadProjectId(null);
    const nextThreads = threadsByProjectId[projectId];
    if (nextThreads) {
      const nextThreadId = nextThreads[0]?.id ?? null;
      if (nextThreadId) {
        selectedThreadIdRef.current = nextThreadId;
        beginTimelineEntry(nextThreadId);
      } else {
        selectedThreadIdRef.current = null;
        clearTimelineEntry();
      }
      setSelectedThreadId(nextThreadId);
      return;
    }
    clearTimelineEntry();
    void loadProjectThreads(projectId, { selectWhenLoaded: true });
  }

  function handleCreateThread(projectId: string) {
    setMobilePanel("chat");
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(projectId);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    clearTimelineEntry();
    resetComposerDraft();
  }

  async function createDraftThreadFromComposer({
    firstMessageText,
    projectId,
  }: {
    firstMessageText: string;
    projectId: string;
  }) {
    draftComposerTransitionOriginRef.current = composerShellRef.current?.getBoundingClientRect() ?? null;
    const thread = optimisticThreadSummary(
      await createThread(projectId, createThreadOptions(composerSettings)),
      firstMessageText,
    );
    setThreadsByProjectId((current) => prependThreadForProject(current, projectId, thread));
    setPendingTitleThreadIds((current) => markThreadTitlePending(current, thread));
    setMaterializingThreadIds((current) => {
      const next = new Set(current);
      next.add(thread.id);
      return next;
    });
    setIsDraftComposerTransitioning(draftComposerTransitionOriginRef.current !== null);
    setDraftThreadProjectId(null);
    selectedThreadIdRef.current = thread.id;
    beginMaterializingTimelineEntry(thread.id);
    setSelectedThreadId(thread.id);
    setDraftComposerTransitionToken((current) => current + 1);
    return thread.id;
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
    setThreadsByProjectId((current) =>
      updateThreadReadStateInProjects(current, threadId, (thread) =>
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
  }

  function handleSelectThread(projectId: string, threadId: string) {
    setMobilePanel("chat");
    if (projectId === selectedProjectId && threadId === selectedThreadId) {
      return;
    }
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(null);
    selectedThreadIdRef.current = threadId;
    beginTimelineEntry(threadId);
    setSelectedThreadId(threadId);
  }

  async function handleArchiveThread(threadId = selectedThreadId) {
    if (!threadId) {
      return;
    }
    await archiveThread(threadId);
    setThreadsByProjectId((current) => removeThreadFromProjects(current, threadId));
    if (threadId === selectedThreadId) {
      clearTimelineEntry();
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
    }
  }

  function handleTimelineReady(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "streamingLive", threadId } : current));
  }

  function handleSelectedThreadSnapshot(thread: ThreadSummary) {
    replaceThread(thread);
    markCompletedAgentTurnSeen(thread.id, thread.lastCompletedAgentTurnSeq);
  }

  function replaceThread(thread: ThreadSummary) {
    applyThreadComposerSettings(thread);
    setThreadsByProjectId((current) => replaceThreadInProjects(current, thread, selectedProjectId));
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

  function resetComposerDraft() {
    setComposerResetToken((current) => current + 1);
  }

  const handleArchiveSelectedThread = useEventCallback(() => void handleArchiveThread());
  const handleArchiveThreadById = useEventCallback((threadId: string) => void handleArchiveThread(threadId));
  const handleCloseLightbox = useEventCallback(() => setLightboxImage(null));
  const handleClosePreferences = useEventCallback(() => setPreferencesOpen(false));
  const handleOpenPreferences = useEventCallback(() => setPreferencesOpen(true));
  const handleTimelineReadyForSelectedThread = useEventCallback(() => {
    const threadId = selectedThreadIdRef.current;
    if (threadId) {
      handleTimelineReady(threadId);
    }
  });
  const stableHandleCreateProject = useEventCallback(handleCreateProject);
  const stableHandleCreateThread = useEventCallback(handleCreateThread);
  const stableHandleSelectProject = useEventCallback(handleSelectProject);
  const stableHandleSelectThread = useEventCallback(handleSelectThread);

  return (
    <>
      <KodexShellView
        composerPanelProps={{
          activeSelectedTurnId, attachmentInputRef, canCompose, composerResetToken, composerSettings, composerSettingsError,
          composerShellRef, contextUsage: selectedContextUsage, isDraftThreadSelected, isDraftComposerTransitioning, isComposerDragActive,
          isComposerSubmitting, isSelectedTimelineReady, models,
          onAbortQueuedSteer: handleAbortQueuedSteer, onAttachmentInputChange: handleAttachmentInputChange,
          onComposerDragLeave: handleComposerDragLeave, onComposerDragOver: handleComposerDragOver, onComposerDrop: handleComposerDrop,
          onComposerKeyDown: handleComposerKeyDown, onComposerPaste: handleComposerPaste, onComposerSettingsChange: handleComposerSettingsChange,
          onImageOpen: setLightboxImage, onRemovePendingAttachment: removePendingAttachment, onStopTurn: handleStopTurn,
          onSubmitQueuedSteer: handleSubmitQueuedSteer, onSubmitTurn: handleSubmitTurn, pendingAttachments, queuedSteerRows,
          selectedThreadPresent: selectedThread !== null,
        }}
        isSidebarResizing={isSidebarResizing}
        mobilePanel={mobilePanel}
        onMobilePanelChange={setMobilePanel}
        preferencesProps={{
          activeSection: preferencesSection, colorSchemeId, onClose: handleClosePreferences, onColorSchemeChange,
          onSectionChange: setPreferencesSection, opened: preferencesOpen,
        }}
        sidebarWidth={sidebarWidth}
        threadPanelProps={{
          errorMessage, imagePreviewUrlsByPath, isDraftThreadSelected, isSelectedTimelineLoading,
          onArchiveThread: handleArchiveSelectedThread, onApprovalDecision: handleApprovalDecision, onImageOpen: setLightboxImage,
          onTimelineReady: handleTimelineReadyForSelectedThread, pendingTitleThreadIds,
          scrollParentElement: timelineScrollElement, selectedThread, selectedThreadApprovals, selectedThreadTitle,
          selectedTimelineEntry, setTimelineScrollElement, showDebugEvents, timeline,
        }}
        workspaceSidebarProps={{
          account, approvals, hoveredThreadActionId, isSidebarResizing, loginState,
          onArchiveThread: handleArchiveThreadById, onCancelLogin: handleCancelLogin,
          onCreateProject: stableHandleCreateProject, onCreateThread: stableHandleCreateThread, onLogin: handleLogin, onLogout: handleLogout,
          onOpenPreferences: handleOpenPreferences, onProjectCwdChange: setProjectCwd, onProjectFormOpenChange: setProjectFormOpen,
          onProjectNameChange: setProjectName, onSelectProject: stableHandleSelectProject, onSelectThread: stableHandleSelectThread,
          onShowDebugEventsChange: setShowDebugEvents, onSidebarResizeKeyDown: handleSidebarResizeKeyDown,
          onSidebarResizePointerDown: handleSidebarResizePointerDown, onThreadActionHoverChange: setHoveredThreadActionId,
          pendingTitleThreadIds, projectCwd, projectFormOpen, projectName, projects, selectedProjectId, selectedThreadId,
          showDebugEvents, sidebarWidth, threadsByProjectId,
        }}
      />
      <ImageLightbox image={lightboxImage} onClose={handleCloseLightbox} />
    </>
  );
}
