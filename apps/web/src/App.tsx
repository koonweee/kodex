import { MantineProvider } from "@mantine/core";
import {
  FormEvent,
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
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [timelineEntry, setTimelineEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCwd, setProjectCwd] = useState("");
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<"appearance">("appearance");
  const [hoveredThreadActionId, setHoveredThreadActionId] = useState<string | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const threadRequestIds = useRef<Map<string, number>>(new Map());
  const nextThreadRequestId = useRef(0);

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
  const isSelectedThreadNotLoaded = selectedThread?.status === "notLoaded";
  const isSelectedTimelineLoading = selectedTimelineEntry.phase === "loading";
  const isSelectedTimelineReady = selectedTimelineEntry.phase === "ready";
  const activeSelectedTurnId = selectedThread !== null ? timeline.activeTurnId : null;
  const isDraftThreadSelected = draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId;
  const canCompose = selectedThread !== null || isDraftThreadSelected;
  const {
    attachmentInputRef,
    canSubmitComposer,
    clearComposerText,
    composerText,
    handleAbortQueuedSteer,
    handleAttachmentInputChange,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerKeyDown,
    handleStopTurn,
    handleSubmitQueuedSteer,
    handleSubmitTurn,
    imagePreviewUrlsByPath,
    isComposerDragActive,
    isComposerSubmitting,
    pendingAttachments,
    queuedSteerRows,
    removePendingAttachment,
    setComposerText,
    shouldShowStopAction,
  } = useComposerOrchestration({
    activeSelectedTurnId,
    canCompose,
    composerSettings,
    draftThreadProjectId,
    isDraftThreadSelected,
    onCreateDraftThread: createDraftThreadFromComposer,
    onError: reportError,
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
    onApprovalEvent: applyApprovalEventWithTombstone,
    onApprovalEvents: applyApprovalEventsWithTombstone,
    onError: reportError,
    onThreadMetadataEvent: applyThreadMetadataEvent,
    onThreadMetadataEvents: applyThreadMetadataEvents,
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
    setTimelineEntry({ phase: "loading", threadId });
  }

  function markTimelineEntryAligning(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "aligning", threadId } : current));
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
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(projectId);
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    clearTimelineEntry();
    clearComposerText();
  }

  async function createDraftThreadFromComposer({
    firstMessageText,
    projectId,
  }: {
    firstMessageText: string;
    projectId: string;
  }) {
    const thread = optimisticThreadSummary(
      await createThread(projectId, createThreadOptions(composerSettings)),
      firstMessageText,
    );
    setThreadsByProjectId((current) => prependThreadForProject(current, projectId, thread));
    setPendingTitleThreadIds((current) => markThreadTitlePending(current, thread));
    setDraftThreadProjectId(null);
    selectedThreadIdRef.current = thread.id;
    beginTimelineEntry(thread.id);
    setSelectedThreadId(thread.id);
    return thread.id;
  }

  function handleSelectThread(projectId: string, threadId: string) {
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
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "ready", threadId } : current));
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

  return (
    <KodexShellView
      composerPanelProps={{
        attachmentInputRef, canCompose, canSubmitComposer, composerSettings, composerSettingsError, composerText,
        contextUsage: selectedContextUsage, isComposerDragActive, isComposerSubmitting, isSelectedTimelineReady, models,
        onAbortQueuedSteer: handleAbortQueuedSteer, onAttachmentInputChange: handleAttachmentInputChange,
        onComposerDragLeave: handleComposerDragLeave, onComposerDragOver: handleComposerDragOver, onComposerDrop: handleComposerDrop,
        onComposerKeyDown: handleComposerKeyDown, onComposerSettingsChange: handleComposerSettingsChange,
        onComposerTextChange: setComposerText, onRemovePendingAttachment: removePendingAttachment, onStopTurn: handleStopTurn,
        onSubmitQueuedSteer: handleSubmitQueuedSteer, onSubmitTurn: handleSubmitTurn, pendingAttachments, queuedSteerRows,
        selectedThreadPresent: selectedThread !== null, shouldShowStopAction,
      }}
      isSidebarResizing={isSidebarResizing}
      mobilePanel={mobilePanel}
      onMobilePanelChange={setMobilePanel}
      preferencesProps={{
        activeSection: preferencesSection, colorSchemeId, onClose: () => setPreferencesOpen(false), onColorSchemeChange,
        onSectionChange: setPreferencesSection, opened: preferencesOpen,
      }}
      sidebarWidth={sidebarWidth}
      threadPanelProps={{
        errorMessage, imagePreviewUrlsByPath, isDraftThreadSelected, isSelectedTimelineLoading,
        onArchiveThread: () => void handleArchiveThread(), onApprovalDecision: handleApprovalDecision,
        onTimelineReady: () => selectedThread && handleTimelineReady(selectedThread.id), pendingTitleThreadIds,
        scrollParentElement: timelineScrollElement, selectedThread, selectedThreadApprovals, selectedThreadTitle,
        selectedTimelineEntry, setTimelineScrollElement, showDebugEvents, timeline,
      }}
      workspaceSidebarProps={{
        account, approvals, hoveredThreadActionId, isSidebarResizing, loginState,
        onArchiveThread: (threadId) => void handleArchiveThread(threadId), onCancelLogin: handleCancelLogin,
        onCreateProject: handleCreateProject, onCreateThread: handleCreateThread, onLogin: handleLogin, onLogout: handleLogout,
        onOpenPreferences: () => setPreferencesOpen(true), onProjectCwdChange: setProjectCwd, onProjectFormOpenChange: setProjectFormOpen,
        onProjectNameChange: setProjectName, onSelectProject: handleSelectProject, onSelectThread: handleSelectThread,
        onShowDebugEventsChange: setShowDebugEvents, onSidebarResizeKeyDown: handleSidebarResizeKeyDown,
        onSidebarResizePointerDown: handleSidebarResizePointerDown, onThreadActionHoverChange: setHoveredThreadActionId,
        pendingTitleThreadIds, projectCwd, projectFormOpen, projectName, projects, selectedProjectId, selectedThreadId,
        showDebugEvents, sidebarWidth, threadsByProjectId,
      }}
    />
  );
}
