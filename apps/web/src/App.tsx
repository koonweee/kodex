import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  MantineProvider,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  createTheme,
} from "@mantine/core";
import {
  ArrowDownToLine,
  AlertCircle,
  Archive,
  Check,
  Folder,
  GitBranch,
  Inbox,
  LogIn,
  MoreHorizontal,
  Paperclip,
  PanelRightOpen,
  Plus,
  ArrowUp,
  Settings,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import {
  type Dispatch,
  FormEvent,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  archiveThread,
  cancelLogin,
  createProject,
  createThread,
  decideApproval,
  getAccount,
  interruptTurn,
  listEvents,
  listModels,
  listPendingApprovals,
  listProjects,
  listThreads,
  logout,
  resumeThread,
  startLogin,
  startTurn,
  steerTurn,
  uploadImages,
  type AccountResponse,
  type Approval,
  type ApprovalResponse,
  type EventEnvelope,
  type ImageUpload,
  type ModelSummary,
  type Project,
  type ThreadSummary,
  type CreateThreadOptions,
  type TurnStartOptions,
  type UserInput,
} from "./api/client";
import {
  ComposerFooterControls,
  type ComposerSettings,
  type ContextUsage,
  type PermissionPresetId,
} from "./ComposerFooterControls";
import { createEventStreamClient } from "./events/stream";
import { applyTimelineEventBatch } from "./timeline/batch";
import {
  buildApprovalIndex,
  deriveTimelineRows,
  getTimelineRowApprovals,
  getUnanchoredApprovals,
  type TimelineRow,
} from "./timeline/derive";
import { TimelineActivityGroupRenderer, TimelineItemRenderer } from "./timeline/renderers";
import {
  addOptimisticUserMessage,
  createTimelineState,
  removeOptimisticUserMessage,
  replayTimeline,
  updateOptimisticUserMessage,
  type TimelineImage,
  type TimelineState,
} from "./timeline/reducer";
import "./App.css";

const theme = createTheme({
  primaryColor: "teal",
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
});

const UI_TEXT = {
  appName: "Kodex",
  approvals: {
    commandTitle: "Would you like to run the following command?",
    emptyText: "Command, file, and permission requests will appear here.",
    emptyTitle: "No pending approvals",
    fallbackTitle: "Approval request",
    fileTitle: "Would you like to make the following edits?",
    label: "Approvals",
    mcpTitle: "MCP approval",
    permissionsTitle: "Would you like to grant these permissions?",
    pending: "pending",
    toolInputTitle: "Input requested",
  },
  auth: {
    cancel: "Cancel login",
    connect: "Connect ChatGPT",
    logout: "Logout",
    open: "Open ChatGPT auth",
    settings: "Account settings",
  },
  composer: {
    addAttachment: "Add attachment",
    attachments: "Attachment options",
    disabledPlaceholder: "Select a thread to start composing",
    dropImages: "Drop images to attach",
    openAttachments: "Open attachment menu",
    placeholder: "type clever thing here",
    send: "Send message",
    stop: "Stop turn",
  },
  empty: {
    noEventsText: "Thread activity will stream into this timeline.",
    noEventsTitle: "No events",
    noProjectsText: "Create a project to begin.",
    noProjectsTitle: "No projects",
    noThreadsText: "Start a thread for this project.",
    noThreadsTitle: "No threads",
    threadTimelineText: "Select or create a thread to view events, messages, tool calls, and warnings.",
    threadTimelineTitle: "Thread timeline",
  },
  mobile: {
    chat: "Chat",
    label: "Mobile panels",
    threads: "Threads",
  },
  project: {
    cwd: "Working directory",
    name: "Project name",
    new: "New project",
    submit: "Create project",
    title: "Projects",
  },
  shell: {
    mainLabel: "Thread",
    resizeSidebarLabel: "Resize workspace sidebar",
    workspaceLabel: "Workspace",
  },
  status: {
    debugEvents: "Show debug events",
  },
  timeline: {
    scrollToBottom: "Scroll to bottom",
  },
  thread: {
    archive: "Archive thread",
    actions: "Thread actions",
    new: "New thread",
    title: "Threads",
    untitled: "Untitled thread",
  },
  turn: {
    abortButton: "Abort queued message",
    queueLabel: "Queued steer messages",
    queueRow: "Queued steer message",
    steerButton: "Steer",
  },
};

type LoginState = {
  loginId?: string | null;
  authUrl?: string | null;
};

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <KodexShell />
    </MantineProvider>
  );
}

type MobilePanel = "threads" | "chat";
type ThreadsByProjectId = Record<string, ThreadSummary[]>;
type TimelineEntry =
  | { phase: "idle"; threadId: null }
  | { phase: "loading" | "aligning" | "ready"; threadId: string };
type QueuedSteerRow = {
  id: string;
  text: string;
  attachments: PendingAttachment[];
  isSubmitting?: boolean;
};
type ComposerContext = {
  activeSelectedTurnId: string | null;
  draftThreadProjectId: string | null;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
};
type PendingAttachment = {
  id: string;
  file: File;
  objectUrl: string;
  status: "pending" | "uploading" | "uploaded" | "error";
  uploaded?: ImageUpload;
  error?: string;
};

const SIDEBAR_MIN_WIDTH = 292;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 24;
const EMPTY_APPROVALS: Approval[] = [];
const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = { fast: false };
const INITIAL_BOTTOM_STABLE_FRAMES = 2;
// Covers virtual row measurement for long messages before the first visible reveal.
const INITIAL_BOTTOM_MAX_SETTLE_FRAMES = 90;
const BOTTOM_DISTANCE_EPSILON = 2;
const disableTimelineScrollAdjustment = () => false;

const idleTimelineEntry: TimelineEntry = { phase: "idle", threadId: null };

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function getDistanceFromBottom(scrollElement: HTMLElement) {
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
}

function isSettledAtBottom(scrollElement: HTMLElement | null, previousScrollHeight: number, rowCount: number) {
  if (!scrollElement) {
    return true;
  }
  return (
    scrollElement.scrollHeight === previousScrollHeight &&
    hasRenderedTimelineBottom(scrollElement, rowCount) &&
    Math.abs(getDistanceFromBottom(scrollElement)) < BOTTOM_DISTANCE_EPSILON
  );
}

function hasRenderedTimelineBottom(scrollElement: HTMLElement, rowCount: number) {
  if (rowCount === 0) {
    return true;
  }
  return scrollElement.querySelector(`[data-index="${rowCount - 1}"]`) !== null;
}

function KodexShell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadsByProjectId, setThreadsByProjectId] = useState<ThreadsByProjectId>({});
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [timelineEntry, setTimelineEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [contextUsageByThreadId, setContextUsageByThreadId] = useState<Record<string, ContextUsage>>({});
  const [loginState, setLoginState] = useState<LoginState>({});
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCwd, setProjectCwd] = useState("");
  const [composerText, setComposerText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isComposerSubmitting, setIsComposerSubmitting] = useState(false);
  const [isComposerDragActive, setIsComposerDragActive] = useState(false);
  const [imagePreviewUrlsByPath, setImagePreviewUrlsByPath] = useState<Record<string, string>>({});
  const [queuedSteerRows, setQueuedSteerRows] = useState<QueuedSteerRow[]>([]);
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_MIN_WIDTH);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizeStart = useRef<{ x: number; width: number } | null>(null);
  const [timelineScrollElement, setTimelineScrollElement] = useState<HTMLDivElement | null>(null);
  const resolvedApprovalIds = useRef<Set<string>>(new Set());
  const selectedProjectIdRef = useRef<string | null>(null);
  const threadRequestIds = useRef<Map<string, number>>(new Map());
  const nextThreadRequestId = useRef(0);
  const nextQueuedSteerId = useRef(0);
  const nextAttachmentId = useRef(0);
  const nextOptimisticMessageId = useRef(0);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const composerContextRef = useRef<ComposerContext | null>(null);
  const latestComposerContextRef = useRef<ComposerContext | null>(null);
  const imagePreviewUrlsByPathRef = useRef<Record<string, string>>({});

  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? [] : [];
  const selectedThread = selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedThreadApprovals = useMemo(
    () => (selectedThreadId ? approvals.filter((approval) => approval.threadId === selectedThreadId) : []),
    [approvals, selectedThreadId],
  );
  const selectedTimelineEntry =
    selectedThread !== null && timelineEntry.threadId === selectedThread.id ? timelineEntry : idleTimelineEntry;
  const isSelectedThreadNotLoaded = selectedThread?.status === "notLoaded";
  const isSelectedTimelineLoading = selectedTimelineEntry.phase === "loading";
  const isSelectedTimelineReady = selectedTimelineEntry.phase === "ready";
  const activeSelectedTurnId = selectedThread !== null ? timeline.activeTurnId : null;
  const hasActiveSelectedTurn = activeSelectedTurnId !== null;
  const isDraftThreadSelected = draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId;
  const canCompose = selectedThread !== null || isDraftThreadSelected;
  const canSubmitComposer =
    canCompose && !isComposerSubmitting && (Boolean(composerText.trim()) || pendingAttachments.length > 0);
  const shouldShowStopAction = hasActiveSelectedTurn && !canSubmitComposer;
  const selectedContextUsage = selectedThreadId ? contextUsageByThreadId[selectedThreadId] : null;
  const selectedThreadTitle = selectedThread
    ? pendingTitleThreadIds.has(selectedThread.id)
      ? UI_TEXT.thread.new
      : threadDisplayTitle(selectedThread)
    : UI_TEXT.thread.new;

  useEffect(() => {
    loadInitialState();
  }, []);

  useEffect(() => {
    const nextContext = { activeSelectedTurnId, draftThreadProjectId, selectedProjectId, selectedThreadId };
    const previousContext = composerContextRef.current;
    composerContextRef.current = nextContext;
    latestComposerContextRef.current = nextContext;
    if (
      previousContext &&
      previousContext.activeSelectedTurnId === activeSelectedTurnId &&
      previousContext.draftThreadProjectId === draftThreadProjectId &&
      previousContext.selectedProjectId === selectedProjectId &&
      previousContext.selectedThreadId === selectedThreadId
    ) {
      return;
    }
    if (isComposerSubmitting) {
      return;
    }

    setQueuedSteerRows((current) => {
      for (const row of current) {
        for (const attachment of row.attachments) {
          releaseAttachmentObjectUrl(attachment);
        }
      }
      return [];
    });
    clearPendingAttachments();
  }, [selectedProjectId, selectedThreadId, draftThreadProjectId, activeSelectedTurnId, isComposerSubmitting]);

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const start = sidebarResizeStart.current;
      if (!start) {
        return;
      }
      setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.x));
    }

    function finishResize() {
      sidebarResizeStart.current = null;
      setIsSidebarResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    const client = createEventStreamClient({
      onEvent: (event) => {
        applyThreadMetadataEvent(event);
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

  async function loadInitialState() {
    try {
      const nextProjects = await listProjects();
      const firstProjectId = nextProjects[0]?.id ?? null;
      setProjects(nextProjects);
      selectedProjectIdRef.current = firstProjectId;
      setSelectedProjectId(firstProjectId);
      nextProjects.forEach((project, index) => {
        void loadProjectThreads(project.id, { selectWhenLoaded: index === 0 });
      });
    } catch (error) {
      reportError(error);
    }

    void listPendingApprovals()
      .then((nextApprovals) => {
        setApprovals((current) =>
          mergePendingApprovals(
            current,
            nextApprovals.filter((approval) => !resolvedApprovalIds.current.has(approval.id)),
          ),
        );
      })
      .catch(reportError);

    void getAccount()
      .then(setAccount)
      .catch(reportError);

    void listModels()
      .then(setModels)
      .catch(reportError);
  }

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
        latestComposerContextRef.current = {
          activeSelectedTurnId: null,
          draftThreadProjectId: null,
          selectedProjectId: projectId,
          selectedThreadId: nextThreadId,
        };
        if (nextThreadId) {
          beginTimelineEntry(nextThreadId);
        } else {
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
    setSelectedProjectId(projectId);
    setSelectedThreadId(null);
    setDraftThreadProjectId(null);
    const nextThreads = threadsByProjectId[projectId];
    if (nextThreads) {
      const nextThreadId = nextThreads[0]?.id ?? null;
      latestComposerContextRef.current = {
        activeSelectedTurnId: null,
        draftThreadProjectId: null,
        selectedProjectId: projectId,
        selectedThreadId: nextThreadId,
      };
      if (nextThreadId) {
        beginTimelineEntry(nextThreadId);
      } else {
        clearTimelineEntry();
      }
      setSelectedThreadId(nextThreadId);
      return;
    }
    latestComposerContextRef.current = {
      activeSelectedTurnId: null,
      draftThreadProjectId: null,
      selectedProjectId: projectId,
      selectedThreadId: null,
    };
    clearTimelineEntry();
    void loadProjectThreads(projectId, { selectWhenLoaded: true });
  }

  function handleCreateThread(projectId: string) {
    selectedProjectIdRef.current = projectId;
    latestComposerContextRef.current = {
      activeSelectedTurnId: null,
      draftThreadProjectId: projectId,
      selectedProjectId: projectId,
      selectedThreadId: null,
    };
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(projectId);
    setSelectedThreadId(null);
    clearTimelineEntry();
    setComposerText("");
  }

  function handleSelectThread(projectId: string, threadId: string) {
    if (projectId === selectedProjectId && threadId === selectedThreadId) {
      return;
    }
    selectedProjectIdRef.current = projectId;
    latestComposerContextRef.current = {
      activeSelectedTurnId: null,
      draftThreadProjectId: null,
      selectedProjectId: projectId,
      selectedThreadId: threadId,
    };
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(null);
    beginTimelineEntry(threadId);
    setSelectedThreadId(threadId);
  }

  async function handleArchiveThread() {
    if (!selectedThreadId) {
      return;
    }
    await archiveThread(selectedThreadId);
    setThreadsByProjectId((current) => removeThreadFromProjects(current, selectedThreadId));
    clearTimelineEntry();
    setSelectedThreadId(null);
  }

  async function handleSubmitTurn(event: FormEvent) {
    event.preventDefault();
    if (!canSubmitComposer) {
      return;
    }

    const text = composerText.trim();
    const attachments = pendingAttachments;
    if (selectedThreadId && activeSelectedTurnId) {
      const id = `queued-steer-${nextQueuedSteerId.current + 1}`;
      nextQueuedSteerId.current += 1;
      setQueuedSteerRows((current) => [...current, { id, text, attachments }]);
      setComposerText("");
      setPendingAttachments([]);
      return;
    }

    const optimisticImages = attachmentPreviewImages(attachments);
    const initialConfirmationState = attachments.length > 0 ? "uploading" : "sending";
    let optimisticClientRequestId: string | null = null;
    let retryRestoreContext: ComposerContext = {
      activeSelectedTurnId,
      draftThreadProjectId,
      selectedProjectId,
      selectedThreadId,
    };
    setIsComposerSubmitting(true);
    try {
      if (selectedThreadId) {
        optimisticClientRequestId = addOptimisticMessage(text, optimisticImages, null, initialConfirmationState);
        setComposerText("");
        const input = await buildTurnInput(text, attachments);
        const uploadedImages = userInputImages(input);
        if (uploadedImages.length > 0) {
          updateOptimisticMessage(optimisticClientRequestId, {
            images: uploadedImages,
            confirmationState: "sending",
            error: undefined,
          });
        }
        await startTurn(selectedThreadId, input, composerTurnOptions(composerSettings));
        updateOptimisticMessage(optimisticClientRequestId, { confirmationState: "sent", error: undefined });
        clearPendingAttachments();
        setIsComposerSubmitting(false);
        return;
      }

      if (!isDraftThreadSelected || !selectedProjectId) {
        setIsComposerSubmitting(false);
        return;
      }

      const thread = await createThread(selectedProjectId, createThreadOptions(composerSettings));
      setThreadsByProjectId((current) => prependThreadForProject(current, selectedProjectId, thread));
      setPendingTitleThreadIds((current) => markThreadTitlePending(current, thread));
      setDraftThreadProjectId(null);
      beginTimelineEntry(thread.id);
      setSelectedThreadId(thread.id);
      retryRestoreContext = {
        activeSelectedTurnId: null,
        draftThreadProjectId: null,
        selectedProjectId,
        selectedThreadId: thread.id,
      };
      latestComposerContextRef.current = retryRestoreContext;
      composerContextRef.current = retryRestoreContext;
      optimisticClientRequestId = addOptimisticMessage(text, optimisticImages, null, initialConfirmationState);
      setComposerText("");
      const input = await buildTurnInput(text, attachments);
      const uploadedImages = userInputImages(input);
      if (uploadedImages.length > 0) {
        updateOptimisticMessage(optimisticClientRequestId, {
          images: uploadedImages,
          confirmationState: "sending",
          error: undefined,
        });
      }
      await startTurn(thread.id, input, composerTurnOptions(composerSettings));
      updateOptimisticMessage(optimisticClientRequestId, { confirmationState: "sent", error: undefined });
      clearPendingAttachments();
      setIsComposerSubmitting(false);
    } catch (error) {
      if (optimisticClientRequestId) {
        const clientRequestId = optimisticClientRequestId;
        setTimeline((current) => removeOptimisticUserMessage(current, clientRequestId));
      }
      if (sameComposerContext(latestComposerContextRef.current, retryRestoreContext)) {
        setComposerText(text);
      } else {
        clearPendingAttachments();
      }
      setIsComposerSubmitting(false);
      reportError(error);
    }
  }

  async function handleStopTurn() {
    if (!selectedThreadId || !activeSelectedTurnId) {
      return;
    }

    await interruptTurn(selectedThreadId, activeSelectedTurnId);
  }

  async function handleSubmitQueuedSteer(row: QueuedSteerRow) {
    if (!selectedThreadId || !activeSelectedTurnId) {
      return;
    }

    const optimisticClientRequestId = addOptimisticMessage(
      row.text,
      attachmentPreviewImages(row.attachments),
      activeSelectedTurnId,
      row.attachments.length > 0 ? "uploading" : "sending",
    );
    setQueuedSteerRows((current) =>
      current.map((item) => (item.id === row.id ? { ...item, isSubmitting: true } : item)),
    );
    try {
      const input = await buildTurnInput(row.text, row.attachments);
      const uploadedImages = userInputImages(input);
      if (uploadedImages.length > 0) {
        updateOptimisticMessage(optimisticClientRequestId, {
          images: uploadedImages,
          confirmationState: "sending",
          error: undefined,
        });
      }
      await steerTurn(selectedThreadId, activeSelectedTurnId, input);
      updateOptimisticMessage(optimisticClientRequestId, { confirmationState: "sent", error: undefined });
      for (const attachment of row.attachments) {
        releaseAttachmentObjectUrl(attachment);
      }
      setQueuedSteerRows((current) => current.filter((item) => item.id !== row.id));
    } catch (error) {
      setTimeline((current) => removeOptimisticUserMessage(current, optimisticClientRequestId));
      setQueuedSteerRows((current) =>
        current.map((item) => (item.id === row.id ? { ...item, isSubmitting: false } : item)),
      );
      reportError(error);
    }
  }

  function handleAbortQueuedSteer(row: QueuedSteerRow) {
    for (const attachment of row.attachments) {
      releaseAttachmentObjectUrl(attachment);
    }
    setQueuedSteerRows((current) => current.filter((item) => item.id !== row.id));
  }

  async function buildTurnInput(text: string, attachments: PendingAttachment[]): Promise<UserInput[]> {
    const input: UserInput[] = [];
    if (text) {
      input.push({ type: "text", text });
    }
    if (attachments.length > 0) {
      const attachmentsToUpload = attachments.filter((attachment) => !attachment.uploaded);
      updateAttachments(
        new Map(
          attachmentsToUpload.map((attachment) => [
            attachment.id,
            { status: "uploading" as const, error: undefined },
          ]),
        ),
      );
      let uploads: ImageUpload[] = [];
      try {
        uploads =
          attachmentsToUpload.length > 0
            ? await uploadImages(attachmentsToUpload.map((attachment) => attachment.file))
            : [];
        if (uploads.length !== attachmentsToUpload.length) {
          throw new Error("Gateway upload response did not match selected attachments");
        }
      } catch (error) {
        const message = errorMessageFrom(error);
        updateAttachments(
          new Map(
            attachmentsToUpload.map((attachment) => [
              attachment.id,
              { status: "error" as const, error: message },
            ]),
          ),
        );
        throw error;
      }

      const previewUrls: Record<string, string> = {};
      const uploadedByAttachmentId = new Map<string, ImageUpload>();
      for (const [index, upload] of uploads.entries()) {
        const attachment = attachmentsToUpload[index];
        if (attachment) {
          uploadedByAttachmentId.set(attachment.id, upload);
          previewUrls[upload.path] = attachment.objectUrl;
        }
      }
      updateAttachments(
        new Map(
          attachmentsToUpload.map((attachment) => [
            attachment.id,
            { status: "uploaded" as const, uploaded: uploadedByAttachmentId.get(attachment.id), error: undefined },
          ]),
        ),
      );
      for (const attachment of attachments) {
        const upload = attachment.uploaded ?? uploadedByAttachmentId.get(attachment.id);
        if (!upload) {
          continue;
        }
        input.push({ type: "localImage", path: upload.path });
      }
      if (Object.keys(previewUrls).length > 0) {
        rememberImagePreviewUrls(previewUrls);
      }
    }
    return input;
  }

  function updateAttachments(updates: Map<string, Partial<PendingAttachment>>) {
    if (updates.size === 0) {
      return;
    }

    const applyUpdates = (attachment: PendingAttachment) => {
      const update = updates.get(attachment.id);
      return update ? { ...attachment, ...update } : attachment;
    };
    setPendingAttachments((current) => current.map(applyUpdates));
    setQueuedSteerRows((current) =>
      current.map((row) => ({
        ...row,
        attachments: row.attachments.map(applyUpdates),
      })),
    );
  }

  function rememberImagePreviewUrls(previewUrls: Record<string, string>) {
    imagePreviewUrlsByPathRef.current = { ...imagePreviewUrlsByPathRef.current, ...previewUrls };
    setImagePreviewUrlsByPath(imagePreviewUrlsByPathRef.current);
  }

  function releaseAttachmentObjectUrl(attachment: PendingAttachment) {
    if (Object.values(imagePreviewUrlsByPathRef.current).includes(attachment.objectUrl)) {
      return;
    }
    revokeObjectUrl(attachment.objectUrl);
  }

  function addOptimisticMessage(
    text: string,
    images: TimelineImage[],
    turnId: string | null,
    confirmationState: "uploading" | "sending" | "sent" | "failed",
  ) {
    nextOptimisticMessageId.current += 1;
    const clientRequestId = `client-message-${nextOptimisticMessageId.current}`;
    setTimeline((current) =>
      addOptimisticUserMessage(current, {
        clientRequestId,
        text,
        images,
        turnId,
        confirmationState,
      }),
    );
    return clientRequestId;
  }

  function updateOptimisticMessage(clientRequestId: string, update: Parameters<typeof updateOptimisticUserMessage>[2]) {
    setTimeline((current) => updateOptimisticUserMessage(current, clientRequestId, update));
  }

  function attachmentPreviewImages(attachments: PendingAttachment[]): TimelineImage[] {
    return attachments.map((attachment) => ({ url: attachment.objectUrl }));
  }

  function userInputImages(input: UserInput[]): TimelineImage[] {
    const images: TimelineImage[] = [];
    for (const item of input) {
      if (item.type === "localImage") {
        images.push({ path: item.path });
      }
      if (item.type === "image") {
        images.push({ url: item.url });
      }
    }
    return images;
  }

  function handleAttachmentInputChange(event: ReactChangeEvent<HTMLInputElement>) {
    if (!canCompose || isComposerSubmitting) {
      event.currentTarget.value = "";
      return;
    }
    appendImageFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function appendImageFiles(fileList: FileList | File[] | null) {
    if (!fileList || isComposerSubmitting) {
      return;
    }
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) {
      return;
    }
    setPendingAttachments((current) => [
      ...current,
      ...files.map((file) => {
        nextAttachmentId.current += 1;
        return {
          id: `attachment-${nextAttachmentId.current}`,
          file,
          objectUrl: createObjectUrl(file),
          status: "pending" as const,
        };
      }),
    ]);
  }

  function removePendingAttachment(id: string) {
    if (isComposerSubmitting) {
      return;
    }
    setPendingAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) {
        releaseAttachmentObjectUrl(removed);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function clearPendingAttachments() {
    setPendingAttachments((current) => {
      for (const attachment of current) {
        releaseAttachmentObjectUrl(attachment);
      }
      return [];
    });
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!canCompose || isComposerSubmitting || !hasImageFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setIsComposerDragActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsComposerDragActive(false);
    }
  }

  function handleComposerDrop(event: ReactDragEvent<HTMLElement>) {
    if (!canCompose || isComposerSubmitting || !hasImageFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setIsComposerDragActive(false);
    appendImageFiles(event.dataTransfer.files);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const handleApprovalDecision = useCallback(async (approval: Approval, decision: ApprovalResponse) => {
    const resolved = await decideApproval(approval.id, decision);
    resolvedApprovalIds.current.add(resolved.id);
    setApprovals((current) => current.filter((item) => item.id !== approval.id));
  }, []);

  const handleTimelineReady = useCallback((threadId: string) => {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "ready", threadId } : current));
  }, []);

  async function handleLogin() {
    const login = await startLogin();
    setLoginState({ authUrl: login.authUrl, loginId: login.loginId });
  }

  async function handleCancelLogin() {
    if (!loginState.loginId) {
      return;
    }
    await cancelLogin(loginState.loginId);
    setLoginState({});
  }

  async function handleLogout() {
    await logout();
    setAccount({ requiresOpenaiAuth: true, account: null, rawPayload: {} });
  }

  function replaceThread(thread: ThreadSummary) {
    setThreadsByProjectId((current) => replaceThreadInProjects(current, thread, selectedProjectId));
    if (isThreadTitleAvailable(thread)) {
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

  function applyThreadMetadataEvent(event: EventEnvelope) {
    const tokenUsage = contextUsageFromEvent(event);
    if (tokenUsage && event.threadId) {
      setContextUsageByThreadId((current) => ({ ...current, [event.threadId as string]: tokenUsage }));
    }

    const update = threadNameUpdateFromEvent(event);
    if (!update) {
      return;
    }

    const name = update.name?.trim();
    if (name) {
      setThreadsByProjectId((current) => updateThreadNameInProjects(current, update.threadId, name));
      setPendingTitleThreadIds((current) => {
        if (!current.has(update.threadId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(update.threadId);
        return next;
      });
    }
  }

  function applyThreadMetadataEvents(events: EventEnvelope[]) {
    for (const event of events) {
      applyThreadMetadataEvent(event);
    }
  }

  function reportError(error: unknown) {
    setErrorMessage(errorMessageFrom(error));
  }

  function applyApprovalEventsWithTombstone(current: Approval[], events: EventEnvelope[]): Approval[] {
    return events.reduce(applyApprovalEventWithTombstone, current);
  }

  function applyApprovalEventWithTombstone(current: Approval[], event: EventEnvelope): Approval[] {
    const approval = approvalFromPayload(event.payload);
    if (approval) {
      if (event.kind === "approval.resolved" || approval.status !== "pending") {
        resolvedApprovalIds.current.add(approval.id);
      } else if (resolvedApprovalIds.current.has(approval.id)) {
        return current;
      }
    }
    return applyApprovalEvent(current, event);
  }

  function handleSidebarResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    sidebarResizeStart.current = { x: event.clientX, width: sidebarWidth };
    setIsSidebarResizing(true);
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((width) => clampSidebarWidth(width - SIDEBAR_RESIZE_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((width) => clampSidebarWidth(width + SIDEBAR_RESIZE_STEP));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MAX_WIDTH);
    }
  }

  return (
    <AppShell
      navbar={{ width: sidebarWidth, breakpoint: "sm" }}
      padding="md"
      className="kodex-shell"
      data-mobile-panel={mobilePanel}
      data-sidebar-resizing={isSidebarResizing ? "true" : undefined}
    >
      <MobilePanelSwitcher activePanel={mobilePanel} onChange={setMobilePanel} />

      <AppShell.Navbar
        aria-label={UI_TEXT.shell.workspaceLabel}
        p="md"
        className="kodex-sidebar"
        style={{ width: sidebarWidth }}
      >
        <Stack gap="lg" h="100%">
          <Box className="kodex-sidebar-scroll">
            <Group justify="space-between" align="center" mb="sm">
              <Text fw={700} size="sm">
                {UI_TEXT.project.title}
              </Text>
              <Tooltip label={UI_TEXT.project.new}>
                <ActionIcon
                  variant="subtle"
                  aria-label={UI_TEXT.project.new}
                  onClick={() => setProjectFormOpen((open) => !open)}
                >
                  <GitBranch size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
            {projectFormOpen ? (
              <Box component="form" className="kodex-project-form" onSubmit={handleCreateProject}>
                <TextInput
                  label={UI_TEXT.project.name}
                  value={projectName}
                  onChange={(event) => setProjectName(event.currentTarget.value)}
                />
                <TextInput
                  label={UI_TEXT.project.cwd}
                  required
                  value={projectCwd}
                  onChange={(event) => setProjectCwd(event.currentTarget.value)}
                />
                <Button type="submit" size="xs" disabled={!projectCwd.trim()}>
                  {UI_TEXT.project.submit}
                </Button>
              </Box>
            ) : null}
            <Stack gap="sm" className="kodex-project-tree">
              {projects.length === 0 ? (
                <EmptyPanel icon={<Inbox size={20} />} title={UI_TEXT.empty.noProjectsTitle} text={UI_TEXT.empty.noProjectsText} />
              ) : (
                projects.map((project) => {
                  const projectThreads = threadsByProjectId[project.id] ?? [];
                  const newThreadLabel =
                    project.id === selectedProjectId ? UI_TEXT.thread.new : `Create thread in ${project.name}`;
                  return (
                    <Box className="kodex-project-group" key={project.id} role="group" aria-label={project.name}>
                      <Box className="kodex-project-row">
                        <button
                          aria-label={`${project.name} ${project.cwd}`}
                          className="kodex-project-select-button"
                          data-active={project.id === selectedProjectId}
                          onClick={() => handleSelectProject(project.id)}
                          type="button"
                        >
                          <Folder size={15} />
                          <Text fw={500} size="xs" lineClamp={1}>
                            {project.name}
                          </Text>
                        </button>
                        <Tooltip label={UI_TEXT.thread.new}>
                          <ActionIcon
                            aria-label={newThreadLabel}
                            color="gray"
                            onClick={() => handleCreateThread(project.id)}
                            size="sm"
                            variant="subtle"
                          >
                            <SquarePen size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Box>
                      {projectThreads.length > 0 ? (
                        <Stack className="kodex-project-thread-list" gap={6}>
                          {projectThreads.map((thread) => {
                            const needsApproval = threadNeedsApproval(thread, approvals);
                            return (
                              <button
                                className="kodex-list-button kodex-thread-list-button"
                                data-active={thread.id === selectedThreadId}
                                key={thread.id}
                                onClick={() => handleSelectThread(project.id, thread.id)}
                                type="button"
                              >
                                <Group
                                  align="flex-start"
                                  className="kodex-thread-list-row"
                                  data-has-approval={needsApproval ? "true" : undefined}
                                  gap="xs"
                                  justify="space-between"
                                  wrap="nowrap"
                                >
                                  <Text
                                    className="kodex-thread-list-title"
                                    c={pendingTitleThreadIds.has(thread.id) ? "dimmed" : undefined}
                                    data-placeholder-title={pendingTitleThreadIds.has(thread.id) ? "true" : undefined}
                                    fw={400}
                                    size="xs"
                                    lineClamp={1}
                                  >
                                    {pendingTitleThreadIds.has(thread.id) ? UI_TEXT.thread.new : threadDisplayTitle(thread)}
                                  </Text>
                                  {needsApproval ? (
                                    <Badge className="kodex-thread-approval-badge" color="orange" size="xs" variant="light">
                                      Needs approval
                                    </Badge>
                                  ) : null}
                                </Group>
                              </button>
                            );
                          })}
                        </Stack>
                      ) : null}
                    </Box>
                  );
                })
              )}
            </Stack>
          </Box>
          <SidebarAccountFooter
            account={account}
            loginState={loginState}
            onCancelLogin={handleCancelLogin}
            onLogin={handleLogin}
            onLogout={handleLogout}
            onShowDebugEventsChange={setShowDebugEvents}
            showDebugEvents={showDebugEvents}
          />
        </Stack>
        <button
          aria-label={UI_TEXT.shell.resizeSidebarLabel}
          aria-orientation="vertical"
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuenow={sidebarWidth}
          className="kodex-sidebar-resize-handle"
          onKeyDown={handleSidebarResizeKeyDown}
          onPointerDown={handleSidebarResizePointerDown}
          role="separator"
          type="button"
        />
      </AppShell.Navbar>

      <AppShell.Main aria-label={UI_TEXT.shell.mainLabel} className="kodex-main">
        <Stack h="calc(100vh - 32px)" gap="md" className="kodex-main-stack">
          {errorMessage ? (
            <Badge className="kodex-main-column" color="red" variant="light" leftSection={<AlertCircle size={12} />}>
              {errorMessage}
            </Badge>
          ) : null}
          {selectedThread || isDraftThreadSelected ? (
            <>
              <Group justify="space-between" wrap="nowrap" className="kodex-thread-header">
                <Box className="kodex-thread-heading">
                  <Title
                    className="kodex-thread-title"
                    c={selectedThread && pendingTitleThreadIds.has(selectedThread.id) ? "dimmed" : undefined}
                    data-placeholder-title={selectedThread && pendingTitleThreadIds.has(selectedThread.id) ? "true" : undefined}
                    order={3}
                    size="h5"
                    title={selectedThreadTitle}
                  >
                    {selectedThreadTitle}
                  </Title>
                </Box>
                {selectedThread ? (
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon aria-label={UI_TEXT.thread.actions} variant="subtle">
                        <MoreHorizontal size={17} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<Archive size={14} />} onClick={handleArchiveThread}>
                        {UI_TEXT.thread.archive}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                ) : null}
              </Group>
              <Box
                className="kodex-timeline-scroll"
                data-entry-phase={selectedTimelineEntry.phase}
                ref={setTimelineScrollElement}
              >
                  {selectedThread && isSelectedTimelineLoading ? (
                    <Box aria-busy="true" className="kodex-timeline-loading" />
                  ) : selectedThread ? (
                    <TimelineView
                      key={selectedThread.id}
                      approvals={selectedThreadApprovals}
                      onReady={() => handleTimelineReady(selectedThread.id)}
                      onApprovalDecision={handleApprovalDecision}
                      imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                      scrollParentElement={timelineScrollElement}
                      showDebug={showDebugEvents}
                      timeline={timeline}
                    />
                  ) : (
                    <EmptyPanel
                      icon={<Inbox size={20} />}
                      title={UI_TEXT.empty.noEventsTitle}
                      text={UI_TEXT.empty.noEventsText}
                    />
                  )}
              </Box>
            </>
          ) : (
            <Box className="kodex-thread-empty kodex-main-column">
              <EmptyPanel
                icon={<PanelRightOpen size={22} />}
                title={UI_TEXT.empty.threadTimelineTitle}
                text={UI_TEXT.empty.threadTimelineText}
              />
            </Box>
          )}
          <Box
            className="kodex-composer-shell kodex-main-column"
            data-entry-ready={selectedThread !== null && !isSelectedTimelineReady ? "false" : "true"}
            data-drag-active={isComposerDragActive ? "true" : "false"}
            onDragLeave={handleComposerDragLeave}
            onDragOver={handleComposerDragOver}
            onDrop={handleComposerDrop}
          >
            {queuedSteerRows.length > 0 ? (
              <QueuedSteerCard
                rows={queuedSteerRows}
                onAbortRow={handleAbortQueuedSteer}
                onSubmitRow={handleSubmitQueuedSteer}
              />
            ) : null}
            <Box component="form" className="kodex-composer" onSubmit={handleSubmitTurn}>
              <input
                ref={attachmentInputRef}
                aria-label={UI_TEXT.composer.addAttachment}
                className="kodex-attachment-input"
                type="file"
                accept="image/*"
                multiple
                disabled={!canCompose || isComposerSubmitting}
                onChange={handleAttachmentInputChange}
              />
              {pendingAttachments.length > 0 && !isComposerSubmitting ? (
                <AttachmentTray attachments={pendingAttachments} onRemove={removePendingAttachment} />
              ) : null}
              <Textarea
                aria-label="Message composer"
                className="kodex-composer-textarea"
                placeholder={canCompose ? UI_TEXT.composer.placeholder : UI_TEXT.composer.disabledPlaceholder}
                minRows={2}
                maxRows={10}
                autosize
                value={composerText}
                onChange={(event) => {
                  if (!isComposerSubmitting) {
                    setComposerText(event.currentTarget.value);
                  }
                }}
                onKeyDown={handleComposerKeyDown}
                disabled={!canCompose || isComposerSubmitting}
                variant="unstyled"
              />
              {isComposerDragActive ? (
                <Box className="kodex-composer-drop-hint" aria-hidden="true">
                  {UI_TEXT.composer.dropImages}
                </Box>
              ) : null}
              <Group className="kodex-composer-toolbar" justify="space-between" wrap="wrap">
                <Group className="kodex-composer-toolbar-left" gap={6} wrap="nowrap">
                  <Menu position="top-start" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        aria-label={UI_TEXT.composer.openAttachments}
                        className="kodex-composer-secondary-action"
                        size="md"
                        type="button"
                        variant="subtle"
                        disabled={!canCompose || isComposerSubmitting}
                      >
                        <Plus size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown aria-label={UI_TEXT.composer.attachments}>
                      <Menu.Item
                        disabled={!canCompose || isComposerSubmitting}
                        leftSection={<Paperclip size={14} />}
                        onClick={() => attachmentInputRef.current?.click()}
                      >
                        {UI_TEXT.composer.addAttachment}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  <ComposerFooterControls
                    contextUsage={selectedContextUsage}
                    disabled={!canCompose || isComposerSubmitting}
                    models={models}
                    settings={composerSettings}
                    onSettingsChange={setComposerSettings}
                  />
                </Group>
                <Tooltip label={shouldShowStopAction ? UI_TEXT.composer.stop : UI_TEXT.composer.send}>
                  {shouldShowStopAction ? (
                    <ActionIcon
                      className="kodex-composer-action"
                      data-action-state="active"
                      aria-label={UI_TEXT.composer.stop}
                      size="md"
                      variant="filled"
                      type="button"
                      disabled={!selectedThread}
                      onClick={handleStopTurn}
                    >
                      <Square size={13} fill="currentColor" strokeWidth={0} />
                    </ActionIcon>
                  ) : (
                    <ActionIcon
                      className="kodex-composer-action"
                      data-action-state="idle"
                      aria-label={UI_TEXT.composer.send}
                      size="md"
                      type="submit"
                      disabled={!canSubmitComposer}
                    >
                      <ArrowUp size={16} />
                    </ActionIcon>
                  )}
                </Tooltip>
              </Group>
            </Box>
          </Box>
        </Stack>
      </AppShell.Main>
    </AppShell>
  );
}

function useSelectedThreadTimeline({
  isSelectedThreadNotLoaded,
  onApprovalEvent,
  onApprovalEvents,
  onError,
  onThreadMetadataEvent,
  onThreadMetadataEvents,
  selectedThreadId,
  setApprovals,
  setTimeline,
  setTimelineEntry,
}: {
  isSelectedThreadNotLoaded: boolean;
  onApprovalEvent: (current: Approval[], event: EventEnvelope) => Approval[];
  onApprovalEvents: (current: Approval[], events: EventEnvelope[]) => Approval[];
  onError: (error: unknown) => void;
  onThreadMetadataEvent: (event: EventEnvelope) => void;
  onThreadMetadataEvents: (events: EventEnvelope[]) => void;
  selectedThreadId: string | null;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
  setTimelineEntry: Dispatch<SetStateAction<TimelineEntry>>;
}) {
  const queuedTimelineEvents = useRef<EventEnvelope[]>([]);
  const timelineFlushFrame = useRef<number | null>(null);
  const timelineFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedThreadStreamToken = useRef(0);
  const latestCallbacks = useRef({ onApprovalEvent, onApprovalEvents, onError, onThreadMetadataEvent, onThreadMetadataEvents });
  latestCallbacks.current = { onApprovalEvent, onApprovalEvents, onError, onThreadMetadataEvent, onThreadMetadataEvents };

  function clearEntry() {
    setTimelineEntry(idleTimelineEntry);
    setTimeline(createTimelineState());
  }

  function beginEntry(threadId: string) {
    setTimeline(createTimelineState());
    setTimelineEntry({ phase: "loading", threadId });
  }

  function markEntryAligning(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "aligning", threadId } : current));
  }

  function clearEntryForThread(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? idleTimelineEntry : current));
  }

  function scheduleQueuedTimelineFlush() {
    if (timelineFlushFrame.current !== null || timelineFlushTimer.current !== null) {
      return;
    }

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      timelineFlushFrame.current = window.requestAnimationFrame(flushQueuedTimelineEvents);
      return;
    }

    timelineFlushTimer.current = setTimeout(flushQueuedTimelineEvents, 16);
  }

  function flushQueuedTimelineEvents() {
    if (timelineFlushFrame.current !== null) {
      timelineFlushFrame.current = null;
    }
    if (timelineFlushTimer.current !== null) {
      timelineFlushTimer.current = null;
    }
    const events = queuedTimelineEvents.current;
    queuedTimelineEvents.current = [];
    if (events.length === 0) {
      return;
    }
    setTimeline((current) => applyTimelineEventBatch(current, events));
  }

  function cancelQueuedTimelineEvents() {
    if (timelineFlushFrame.current !== null) {
      window.cancelAnimationFrame(timelineFlushFrame.current);
      timelineFlushFrame.current = null;
    }
    if (timelineFlushTimer.current !== null) {
      clearTimeout(timelineFlushTimer.current);
      timelineFlushTimer.current = null;
    }
    queuedTimelineEvents.current = [];
  }

  useEffect(() => {
    if (!selectedThreadId) {
      selectedThreadStreamToken.current += 1;
      cancelQueuedTimelineEvents();
      clearEntry();
      return;
    }

    const threadId = selectedThreadId;
    if (isSelectedThreadNotLoaded) {
      beginEntry(threadId);
      return;
    }

    let cancelled = false;
    let closeStream: (() => void) | null = null;
    const streamToken = selectedThreadStreamToken.current + 1;
    selectedThreadStreamToken.current = streamToken;
    listEvents(threadId)
      .then((events) => {
        if (cancelled) {
          return;
        }

        setApprovals((current) => latestCallbacks.current.onApprovalEvents(current, events));
        latestCallbacks.current.onThreadMetadataEvents(events);
        const timelineEvents = events.filter((event) => !isApprovalEvent(event));
        const replayedTimeline = replayTimeline(timelineEvents);
        setTimeline((current) => applyTimelineEventBatch(current, timelineEvents));
        markEntryAligning(threadId);
        const client = createEventStreamClient({
          cursor: replayedTimeline.lastSeq,
          threadId,
          onEvent: (event) => {
            if (selectedThreadStreamToken.current !== streamToken) {
              return;
            }
            if (event.threadId && event.threadId !== threadId) {
              return;
            }
            latestCallbacks.current.onThreadMetadataEvent(event);
            if (isApprovalEvent(event)) {
              setApprovals((current) => latestCallbacks.current.onApprovalEvent(current, event));
              return;
            }
            queuedTimelineEvents.current.push(event);
            scheduleQueuedTimelineFlush();
          },
        });
        client.connect();
        closeStream = client.close;
      })
      .catch((error) => {
        if (!cancelled) {
          clearEntryForThread(threadId);
          latestCallbacks.current.onError(error);
        }
      });

    return () => {
      cancelled = true;
      selectedThreadStreamToken.current += 1;
      closeStream?.();
      cancelQueuedTimelineEvents();
    };
  }, [isSelectedThreadNotLoaded, selectedThreadId, setApprovals, setTimeline, setTimelineEntry]);
}

function MobilePanelSwitcher({
  activePanel,
  onChange,
}: {
  activePanel: MobilePanel;
  onChange: (panel: MobilePanel) => void;
}) {
  const tabs: Array<{ label: string; panel: MobilePanel }> = [
    { label: UI_TEXT.mobile.threads, panel: "threads" },
    { label: UI_TEXT.mobile.chat, panel: "chat" },
  ];

  return (
    <Box aria-label={UI_TEXT.mobile.label} className="kodex-mobile-switcher" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={activePanel === tab.panel}
          className="kodex-mobile-tab"
          data-active={activePanel === tab.panel}
          key={tab.panel}
          onClick={() => onChange(tab.panel)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </Box>
  );
}

function QueuedSteerCard({
  onAbortRow,
  onSubmitRow,
  rows,
}: {
  onAbortRow: (row: QueuedSteerRow) => void;
  onSubmitRow: (row: QueuedSteerRow) => void;
  rows: QueuedSteerRow[];
}) {
  const visibleRows = rows.filter((row) => !row.isSubmitting);
  if (visibleRows.length === 0) {
    return null;
  }

  return (
    <Box aria-label={UI_TEXT.turn.queueLabel} className="kodex-queued-steer" role="region">
      {visibleRows.map((row) => (
        <Box
          aria-label={UI_TEXT.turn.queueRow}
          className="kodex-queued-steer-row"
          data-steer-row-id={row.id}
          key={row.id}
          role="group"
        >
          <Box className="kodex-queued-steer-content">
            {row.attachments.length > 0 ? (
              <AttachmentTray attachments={row.attachments} compact onRemove={() => undefined} />
            ) : null}
            <Text className="kodex-queued-steer-text" size="sm">
              {row.text || `${row.attachments.length} image${row.attachments.length === 1 ? "" : "s"}`}
            </Text>
          </Box>
          <Button className="kodex-queued-steer-button" size="xs" onClick={() => onSubmitRow(row)}>
            {UI_TEXT.turn.steerButton}
          </Button>
          <Tooltip label={UI_TEXT.turn.abortButton}>
            <ActionIcon
              aria-label={UI_TEXT.turn.abortButton}
              className="kodex-queued-steer-abort"
              size="sm"
              type="button"
              variant="subtle"
              onClick={() => onAbortRow(row)}
            >
              <X size={14} />
            </ActionIcon>
          </Tooltip>
        </Box>
      ))}
    </Box>
  );
}

function AttachmentTray({
  attachments,
  compact = false,
  onRemove,
}: {
  attachments: PendingAttachment[];
  compact?: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <Box className="kodex-attachment-tray" data-compact={compact ? "true" : "false"}>
      {attachments.map((attachment) => (
        <Tooltip label={attachment.file.name} key={attachment.id}>
          <Box className="kodex-attachment-thumb">
            <img src={attachment.objectUrl} alt="" />
            {attachment.status === "uploading" ? <Box className="kodex-attachment-status">Uploading</Box> : null}
            {attachment.status === "error" ? <Box className="kodex-attachment-status">Failed</Box> : null}
            {!compact ? (
              <ActionIcon
                aria-label={`Remove ${attachment.file.name}`}
                className="kodex-attachment-remove"
                size="xs"
                type="button"
                variant="filled"
                onClick={() => onRemove(attachment.id)}
              >
                <X size={12} />
              </ActionIcon>
            ) : null}
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}

function SidebarAccountFooter({
  account,
  loginState,
  onCancelLogin,
  onLogin,
  onLogout,
  onShowDebugEventsChange,
  showDebugEvents,
}: {
  account: AccountResponse | null;
  loginState: LoginState;
  onCancelLogin: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  showDebugEvents: boolean;
}) {
  const accountLabel = account?.account?.email ?? account?.account?.accountType ?? UI_TEXT.auth.connect;

  return (
    <Group className="kodex-sidebar-footer" justify="space-between" gap="sm" wrap="nowrap">
      <Group gap="xs" wrap="nowrap" className="kodex-account-summary">
        {account?.account ? (
          <Tooltip label={accountLabel}>
            <Box aria-label={accountLabel} className="kodex-account-avatar" role="img">
              {accountInitial(accountLabel)}
            </Box>
          </Tooltip>
        ) : (
          <Button className="kodex-account-primary" leftSection={<LogIn size={14} />} size="xs" variant="light" onClick={onLogin}>
            {UI_TEXT.auth.connect}
          </Button>
        )}
        {!account?.account && loginState.authUrl ? (
          <Button
            className="kodex-account-secondary"
            component="a"
            href={loginState.authUrl}
            target="_blank"
            rel="noreferrer"
            size="xs"
            variant="subtle"
          >
            {UI_TEXT.auth.open}
          </Button>
        ) : null}
        {!account?.account && loginState.loginId ? (
          <Button className="kodex-account-secondary" size="xs" variant="subtle" color="gray" onClick={onCancelLogin}>
            {UI_TEXT.auth.cancel}
          </Button>
        ) : null}
      </Group>
      <SettingsMenu
        isAuthenticated={Boolean(account?.account)}
        onLogout={onLogout}
        onShowDebugEventsChange={onShowDebugEventsChange}
        showDebugEvents={showDebugEvents}
      />
    </Group>
  );
}

function SettingsMenu({
  isAuthenticated,
  onLogout,
  onShowDebugEventsChange,
  showDebugEvents,
}: {
  isAuthenticated: boolean;
  onLogout: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  showDebugEvents: boolean;
}) {
  return (
    <Menu position="top-end" width={220} withinPortal>
      <Menu.Target>
        <ActionIcon aria-label={UI_TEXT.auth.settings} className="kodex-settings-button" variant="subtle">
          <Settings size={17} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {isAuthenticated ? (
          <Menu.Item onClick={onLogout}>
            {UI_TEXT.auth.logout}
          </Menu.Item>
        ) : null}
        <button
          className="kodex-debug-toggle"
          type="button"
          role="menuitemcheckbox"
          aria-checked={showDebugEvents}
          onClick={() => onShowDebugEventsChange(!showDebugEvents)}
        >
          {UI_TEXT.status.debugEvents}
        </button>
      </Menu.Dropdown>
    </Menu>
  );
}

function useBottomPinnedVirtualTimeline({
  onReady,
  rows,
  scrollParentElement,
  timelineLastSeq,
}: {
  onReady: () => void;
  rows: TimelineRow[];
  scrollParentElement: HTMLDivElement | null;
  timelineLastSeq: number;
}) {
  const rowCount = rows.length;
  const lastRowKey = rows[rowCount - 1]?.key ?? "";
  const nearBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [initialBottomAligned, setInitialBottomAligned] = useState(false);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => 112,
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scrollParentElement,
    initialRect: { width: 900, height: 720 },
    overscan: 8,
  });
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = disableTimelineScrollAdjustment;

  const updateNearBottom = useCallback(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      nearBottomRef.current = true;
      setShowScrollToBottom(false);
      return true;
    }
    const distanceFromBottom = getDistanceFromBottom(scrollElement);
    const isNearBottom = distanceFromBottom < 96;
    nearBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom && rowCount > 0 && distanceFromBottom > 0);
    return isNearBottom;
  }, [rowCount, scrollParentElement]);

  const scrollToTimelineBottom = useCallback(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }
    rowVirtualizer.scrollToIndex(Math.max(0, rowCount - 1), { align: "end" });
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  }, [rowCount, rowVirtualizer, scrollParentElement]);

  const markTimelineReady = useCallback(() => {
    setInitialBottomAligned(true);
    onReady();
  }, [onReady]);

  const finishInitialBottomReveal = useCallback(() => {
    scrollToTimelineBottom();
    updateNearBottom();
    markTimelineReady();
  }, [markTimelineReady, scrollToTimelineBottom, updateNearBottom]);

  const scrollToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setShowScrollToBottom(false);

    scrollToTimelineBottom();
    requestAnimationFrame(() => {
      if (nearBottomRef.current) {
        scrollToTimelineBottom();
      }
      updateNearBottom();
    });
  }, [scrollToTimelineBottom, updateNearBottom]);

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }

    updateNearBottom();
    scrollElement.addEventListener("scroll", updateNearBottom, { passive: true });
    return () => scrollElement.removeEventListener("scroll", updateNearBottom);
  }, [scrollParentElement, updateNearBottom]);

  useLayoutEffect(() => {
    if (initialBottomAligned) {
      return;
    }

    if (rowCount === 0) {
      setShowScrollToBottom(false);
      markTimelineReady();
      return;
    }

    if (!nearBottomRef.current) {
      setShowScrollToBottom(true);
      markTimelineReady();
      return;
    }

    const frameIds: number[] = [];
    const settleBottom = (attempt: number, stableFrames: number, previousScrollHeight: number) => {
      if (!nearBottomRef.current) {
        markTimelineReady();
        return;
      }

      scrollToTimelineBottom();
      const frameId = requestAnimationFrame(() => {
        const scrollElement = scrollParentElement;
        const scrollHeight = scrollElement?.scrollHeight ?? 0;
        const nextStableFrames = isSettledAtBottom(scrollElement, previousScrollHeight, rowCount) ? stableFrames + 1 : 0;

        if (nextStableFrames >= INITIAL_BOTTOM_STABLE_FRAMES || attempt >= INITIAL_BOTTOM_MAX_SETTLE_FRAMES) {
          finishInitialBottomReveal();
          return;
        }

        settleBottom(attempt + 1, nextStableFrames, scrollHeight);
      });
      frameIds.push(frameId);
    };

    settleBottom(0, 0, -1);
    return () => {
      for (const frameId of frameIds) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    finishInitialBottomReveal,
    initialBottomAligned,
    markTimelineReady,
    rowCount,
    scrollParentElement,
    scrollToTimelineBottom,
  ]);

  useLayoutEffect(() => {
    if (!initialBottomAligned || rowCount === 0) {
      return;
    }

    if (nearBottomRef.current) {
      scrollToTimelineBottom();
      const frameId = requestAnimationFrame(() => {
        if (nearBottomRef.current) {
          scrollToTimelineBottom();
        }
        updateNearBottom();
      });
      return () => cancelAnimationFrame(frameId);
    }

    setShowScrollToBottom(true);
  }, [
    initialBottomAligned,
    lastRowKey,
    rowCount,
    scrollToTimelineBottom,
    timelineLastSeq,
    updateNearBottom,
  ]);

  return {
    initialBottomAligned,
    isNearBottom: nearBottomRef.current,
    rowVirtualizer,
    scrollToBottom,
    showScrollToBottom,
  };
}

function TimelineView({
  approvals,
  imagePreviewUrlsByPath,
  onApprovalDecision,
  onReady,
  scrollParentElement,
  showDebug,
  timeline,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onReady: () => void;
  scrollParentElement: HTMLDivElement | null;
  showDebug: boolean;
  timeline: TimelineState;
}) {
  const rows = useMemo(() => deriveTimelineRows(timeline, { showDebug }), [showDebug, timeline]);
  const approvalIndex = useMemo(() => buildApprovalIndex(approvals), [approvals]);
  const unanchoredApprovals = useMemo(
    () => getUnanchoredApprovals(rows, approvalIndex),
    [approvalIndex, rows],
  );
  const approvalsByRowKey = useMemo(() => buildTimelineRowApprovalMap(rows, approvalIndex), [approvalIndex, rows]);
  const rowCount = rows.length;
  const {
    initialBottomAligned,
    isNearBottom,
    rowVirtualizer,
    scrollToBottom,
    showScrollToBottom,
  } = useBottomPinnedVirtualTimeline({
    onReady,
    rows,
    scrollParentElement,
    timelineLastSeq: timeline.lastSeq,
  });

  if (rowCount === 0) {
    return approvals.length > 0 ? (
      <ThreadApprovalStack approvals={approvals} onDecision={onApprovalDecision} />
    ) : (
      <EmptyPanel
        icon={<PanelRightOpen size={22} />}
        title={UI_TEXT.empty.noEventsTitle}
        text={UI_TEXT.empty.noEventsText}
      />
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  const renderedVirtualItems =
    virtualItems.length > 0 ? virtualItems : fallbackVirtualItems(rows, isNearBottom);

  return (
    <Box className="kodex-timeline-virtual-root" data-initial-bottom-aligned={initialBottomAligned ? "true" : "false"}>
      {unanchoredApprovals.length > 0 ? (
        <ThreadApprovalStack approvals={unanchoredApprovals} onDecision={onApprovalDecision} />
      ) : null}
      <Box className="kodex-timeline-virtual-spacer" style={{ height: rowVirtualizer.getTotalSize() }}>
        {renderedVirtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) {
            return null;
          }
          return (
            <Box
              className="kodex-timeline-virtual-row kodex-main-column"
              data-index={virtualItem.index}
              key={virtualItem.key}
              ref={rowVirtualizer.measureElement}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
              onToggle={(event) => {
                if (event.target instanceof HTMLDetailsElement) {
                  rowVirtualizer.measureElement(event.currentTarget);
                }
              }}
            >
              <TimelineRowView
                approvals={approvalsByRowKey.get(row.key) ?? EMPTY_APPROVALS}
                imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                onApprovalDecision={onApprovalDecision}
                row={row}
                showDebug={showDebug}
              />
            </Box>
          );
        })}
      </Box>
      {showScrollToBottom ? (
        <Tooltip label={UI_TEXT.timeline.scrollToBottom}>
          <ActionIcon
            aria-label={UI_TEXT.timeline.scrollToBottom}
            className="kodex-scroll-to-bottom"
            color="gray"
            onClick={scrollToBottom}
            radius="xl"
            size="md"
            variant="light"
          >
            <ArrowDownToLine size={16} />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </Box>
  );
}

const TimelineRowView = memo(function TimelineRowView({
  approvals,
  imagePreviewUrlsByPath,
  onApprovalDecision,
  row,
  showDebug,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  row: TimelineRow;
  showDebug: boolean;
}) {
  return (
    <Box className="kodex-turn-group">
      {row.dividerBefore === "final_response" ? <Box aria-hidden="true" className="kodex-timeline-final-response-divider" /> : null}
      {row.type === "activity" ? (
        <TimelineActivityGroupRenderer items={row.items} showDebug={showDebug} />
      ) : (
        <TimelineItemRenderer item={row.item} imagePreviewUrlsByPath={imagePreviewUrlsByPath} showDebug={showDebug} />
      )}
      {approvals.length > 0 ? (
        <Stack gap="xs" mt="xs">
          {approvals.map((approval) => (
            <ApprovalCard approval={approval} key={approval.id} onDecision={onApprovalDecision} />
          ))}
        </Stack>
      ) : null}
    </Box>
  );
});

function fallbackVirtualItems(rows: TimelineRow[], preferBottom: boolean) {
  const fallbackCount = Math.min(rows.length, 12);
  const startIndex = preferBottom ? Math.max(0, rows.length - fallbackCount) : 0;
  return rows.slice(startIndex, startIndex + fallbackCount).map((row, offset) => ({
    index: startIndex + offset,
    key: row.key,
    start: (startIndex + offset) * 112,
  }));
}

function hasImageFiles(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items);
  if (items.length > 0) {
    return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
  }
  return Array.from(dataTransfer.files).some((file) => file.type.startsWith("image/"));
}

function createObjectUrl(file: File) {
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
}

function revokeObjectUrl(objectUrl: string) {
  if (objectUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(objectUrl);
  }
}

function buildTimelineRowApprovalMap(rows: TimelineRow[], approvalIndex: ReturnType<typeof buildApprovalIndex>) {
  const approvalsByRowKey = new Map<string, Approval[]>();
  for (const row of rows) {
    const rowApprovals = getTimelineRowApprovals(row, approvalIndex);
    if (rowApprovals.length > 0) {
      approvalsByRowKey.set(row.key, rowApprovals);
    }
  }
  return approvalsByRowKey;
}

function ThreadApprovalStack({
  approvals,
  onDecision,
}: {
  approvals: Approval[];
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  return (
    <Stack gap="xs" className="kodex-thread-approvals kodex-main-column">
      {approvals.map((approval) => (
        <ApprovalCard approval={approval} key={approval.id} onDecision={onDecision} />
      ))}
    </Stack>
  );
}

function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: Approval;
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  const actions = approvalActions(approval);
  const parsedActions = approvalParsedActions(approval);
  const subject = approvalSubject(approval);
  const reason = approvalReason(approval);
  const permissionRule = approvalPermissionRule(approval);
  const serverName = approvalServerName(approval);
  const isCommandApproval = normalizedApprovalMethod(approval.method) === "command";

  return (
    <Box className="kodex-approval-card">
      <Text fw={700} size="sm">
        {approvalTitle(approval)}
      </Text>
      {serverName ? (
        <Text size="sm">
          Server: <strong>{serverName}</strong>
        </Text>
      ) : null}
      {reason ? (
        <Text c="dimmed" size="xs">
          Reason: {reason}
        </Text>
      ) : null}
      {permissionRule ? (
        <Text c="dimmed" size="xs">
          Permission rule: {permissionRule}
        </Text>
      ) : null}
      {subject ? (
        isCommandApproval ? (
          <Box className="kodex-approval-command" component="code">
            $ {subject}
          </Box>
        ) : (
          <Text size="sm">{subject}</Text>
        )
      ) : null}
      {parsedActions.length > 0 ? (
        <Stack gap={4} mt="xs">
          {parsedActions.map((action) => (
            <Text c="dimmed" key={action} size="xs">
              {action}
            </Text>
          ))}
        </Stack>
      ) : null}
      <Group gap="xs" mt="sm">
        {actions.map((action) => (
          <Button
            aria-label={action.ariaLabel}
            color={action.color}
            key={action.label}
            leftSection={action.icon}
            size="xs"
            variant={action.variant}
            onClick={() => onDecision(approval, action.response)}
          >
            {action.label}
          </Button>
        ))}
      </Group>
    </Box>
  );
}

function EmptyPanel({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <Box className="kodex-empty">
      <Box className="kodex-empty-icon" aria-hidden="true">
        {icon}
      </Box>
      <Text fw={700} size="sm">
        {title}
      </Text>
      <Text size="sm" c="dimmed">
        {text}
      </Text>
    </Box>
  );
}

function approvalTitle(approval: Approval): string {
  const payload = asRecord(approval.payload);
  switch (normalizedApprovalMethod(approval.method)) {
    case "command": {
      const host = approvalNetworkHost(payload);
      if (host) {
        return `Do you want to approve network access to "${host}"?`;
      }
      return UI_TEXT.approvals.commandTitle;
    }
    case "file":
      return UI_TEXT.approvals.fileTitle;
    case "permissions":
      return UI_TEXT.approvals.permissionsTitle;
    case "mcp_elicitation":
      return `${approvalServerName(approval) ?? "MCP server"} needs your approval.`;
    case "tool_user_input":
      return UI_TEXT.approvals.toolInputTitle;
    default:
      return UI_TEXT.approvals.fallbackTitle;
  }
}

function approvalSubject(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  if (normalizedApprovalMethod(approval.method) === "command" && approvalNetworkHost(payload)) {
    return null;
  }
  return (
    stringValue(payload.command) ??
    stringValue(payload.path) ??
    stringValue(payload.message) ??
    firstQuestionText(payload)
  );
}

function approvalReason(approval: Approval): string | null {
  return stringValue(asRecord(approval.payload).reason);
}

function approvalServerName(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  return stringValue(payload.serverName) ?? stringValue(payload.server_name);
}

function approvalPermissionRule(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  if (normalizedApprovalMethod(approval.method) === "permissions") {
    return permissionRuleText(asRecord(payload.permissions));
  }
  if (normalizedApprovalMethod(approval.method) === "command") {
    return permissionRuleText(asRecord(payload.additionalPermissions));
  }
  return null;
}

type ApprovalAction = {
  ariaLabel: string;
  color?: string;
  icon: React.ReactNode;
  label: string;
  response: ApprovalResponse;
  variant?: "filled" | "light" | "subtle";
};

function approvalActions(approval: Approval): ApprovalAction[] {
  const method = normalizedApprovalMethod(approval.method);

  if (method === "permissions") {
    return permissionsApprovalActions(approval);
  }

  if (method === "mcp_elicitation") {
    return mcpElicitationApprovalActions();
  }

  if (method === "tool_user_input") {
    return [
      {
        ariaLabel: "Submit answers",
        icon: <Check size={14} />,
        label: "Submit",
        response: { answers: defaultToolAnswers(approval.payload) },
      },
    ];
  }

  if (method === "command") {
    return commandApprovalActions(approval);
  }

  if (method === "file") {
    return fileChangeApprovalActions();
  }

  return [];
}

function commandApprovalActions(approval: Approval): ApprovalAction[] {
  const payload = asRecord(approval.payload);
  return commandDecisions(approval).map((decision) => commandApprovalAction(decision, payload));
}

function commandApprovalAction(decision: Record<string, unknown>, payload: Record<string, unknown>): ApprovalAction {
  const kind = stringValue(decision.kind);
  const networkContext = asRecord(payload.networkApprovalContext);
  const hasNetworkContext = Boolean(approvalNetworkHost(payload));
  const hasAdditionalPermissions = Object.keys(asRecord(payload.additionalPermissions)).length > 0;
  if (kind === "accept") {
    return {
      ariaLabel: hasNetworkContext ? "Yes, just this once" : "Yes, proceed",
      icon: <Check size={14} />,
      label: hasNetworkContext ? "Yes, just this once" : "Yes, proceed",
      response: { decision: "accept" },
    };
  }
  if (kind === "acceptForSession") {
    const label = hasNetworkContext
      ? "Yes, and allow this host for this conversation"
      : hasAdditionalPermissions
        ? "Yes, and allow these permissions for this session"
        : "Yes, and don't ask again for this command in this session";
    return {
      ariaLabel: label,
      icon: <Check size={14} />,
      label,
      response: { decision: "acceptForSession" },
      variant: "light",
    };
  }
  if (kind === "acceptWithExecpolicyAmendment") {
    const amendment = decision.execpolicy_amendment;
    const renderedPrefix = execPolicyAmendmentLabel(amendment);
    const label = `Yes, and don't ask again for commands that start with \`${renderedPrefix}\``;
    return {
      ariaLabel: label,
      icon: <Check size={14} />,
      label,
      response: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: amendment,
          },
        },
      },
      variant: "light",
    };
  }
  if (kind === "applyNetworkPolicyAmendment") {
    const amendment = asRecord(decision.network_policy_amendment);
    const fallbackAmendment: Record<string, unknown> =
      Object.keys(networkContext).length > 0 ? { action: "allow", ...networkContext } : {};
    const policyAmendment: Record<string, unknown> =
      Object.keys(amendment).length > 0 ? amendment : fallbackAmendment;
    const action = stringValue(policyAmendment.action);
    const label =
      action === "deny"
        ? "No, and block this host in the future"
        : "Yes, and allow this host in the future";
    return {
      ariaLabel: label,
      color: action === "deny" ? "red" : undefined,
      icon: action === "deny" ? <X size={14} /> : <Check size={14} />,
      label,
      response: {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: policyAmendment,
          },
        },
      },
      variant: "light",
    };
  }
  if (kind === "decline") {
    return {
      ariaLabel: "No, continue without running it",
      color: "red",
      icon: <X size={14} />,
      label: "No, continue without running it",
      response: { decision: "decline" },
      variant: "light",
    };
  }
  return {
    ariaLabel: "No, and tell Codex what to do differently",
    color: "gray",
    icon: <X size={14} />,
    label: "No, and tell Codex what to do differently",
    response: { decision: "cancel" },
    variant: "subtle",
  };
}

function fileChangeApprovalActions(): ApprovalAction[] {
  return [
    {
      ariaLabel: "Yes, proceed",
      icon: <Check size={14} />,
      label: "Yes, proceed",
      response: { decision: "accept" },
    },
    {
      ariaLabel: "Yes, and don't ask again for these files",
      icon: <Check size={14} />,
      label: "Yes, and don't ask again for these files",
      response: { decision: "acceptForSession" },
      variant: "light",
    },
    {
      ariaLabel: "No, and tell Codex what to do differently",
      color: "gray",
      icon: <X size={14} />,
      label: "No, and tell Codex what to do differently",
      response: { decision: "cancel" },
      variant: "subtle",
    },
  ];
}

function permissionsApprovalActions(approval: Approval): ApprovalAction[] {
  const permissions = approvalPermissions(approval);
  return [
    {
      ariaLabel: "Yes, grant these permissions for this turn",
      icon: <Check size={14} />,
      label: "Yes, grant these permissions for this turn",
      response: { permissions, scope: "turn" },
    },
    {
      ariaLabel: "Yes, grant for this turn with strict auto review",
      icon: <Check size={14} />,
      label: "Yes, grant for this turn with strict auto review",
      response: { permissions, scope: "turn", strictAutoReview: true },
      variant: "light",
    },
    {
      ariaLabel: "Yes, grant these permissions for this session",
      icon: <Check size={14} />,
      label: "Yes, grant these permissions for this session",
      response: { permissions, scope: "session" },
      variant: "light",
    },
    {
      ariaLabel: "No, continue without permissions",
      color: "red",
      icon: <X size={14} />,
      label: "No, continue without permissions",
      response: { permissions: {}, scope: "turn" },
      variant: "light",
    },
  ];
}

function mcpElicitationApprovalActions(): ApprovalAction[] {
  return [
    {
      ariaLabel: "Yes, provide the requested info",
      icon: <Check size={14} />,
      label: "Yes, provide the requested info",
      response: { action: "accept" },
    },
    {
      ariaLabel: "No, but continue without it",
      color: "red",
      icon: <X size={14} />,
      label: "No, but continue without it",
      response: { action: "decline" },
      variant: "light",
    },
    {
      ariaLabel: "Cancel this request",
      color: "gray",
      icon: <X size={14} />,
      label: "Cancel this request",
      response: { action: "cancel" },
      variant: "subtle",
    },
  ];
}

function normalizedApprovalMethod(method: string): "command" | "file" | "permissions" | "mcp_elicitation" | "tool_user_input" | "unknown" {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "command_execution":
    case "command":
      return "command";
    case "item/fileChange/requestApproval":
    case "file_change":
    case "file":
      return "file";
    case "item/permissions/requestApproval":
    case "permissions":
      return "permissions";
    case "mcpServer/elicitation/request":
    case "mcp_elicitation":
      return "mcp_elicitation";
    case "item/tool/requestUserInput":
    case "tool_user_input":
      return "tool_user_input";
    default:
      return "unknown";
  }
}

function commandDecisions(approval: Approval): Record<string, unknown>[] {
  const payload = asRecord(approval.payload);
  const availableDecisions = commandAvailableDecisions(payload.availableDecisions);
  if (availableDecisions.length > 0) {
    return availableDecisions;
  }

  if (approvalNetworkHost(payload)) {
    const decisions: Record<string, unknown>[] = [{ kind: "accept" }, { kind: "acceptForSession" }];
    const allowAmendment = networkPolicyAmendments(payload.proposedNetworkPolicyAmendments).find(
      (amendment) => stringValue(amendment.action) === "allow",
    );
    if (allowAmendment) {
      decisions.push({ kind: "applyNetworkPolicyAmendment", network_policy_amendment: allowAmendment });
    }
    decisions.push({ kind: "cancel" });
    return decisions;
  }

  if (Object.keys(asRecord(payload.additionalPermissions)).length > 0) {
    return [{ kind: "accept" }, { kind: "cancel" }];
  }

  const decisions: Record<string, unknown>[] = [{ kind: "accept" }];
  const execpolicyAmendment = execPolicyAmendmentValue(payload.proposedExecpolicyAmendment);
  if (execpolicyAmendment) {
    decisions.push({ kind: "acceptWithExecpolicyAmendment", execpolicy_amendment: execpolicyAmendment });
  }
  decisions.push({ kind: "cancel" });
  return decisions;
}

function commandAvailableDecisions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<Record<string, unknown>[]>((decisions, item) => {
    if (typeof item === "string") {
      decisions.push({ kind: item });
      return decisions;
    }

    const record = asRecord(item);
    if (record.acceptWithExecpolicyAmendment) {
      const amendment = asRecord(record.acceptWithExecpolicyAmendment);
      decisions.push({
        kind: "acceptWithExecpolicyAmendment",
        execpolicy_amendment: amendment.execpolicy_amendment ?? amendment.proposed_execpolicy_amendment,
      });
      return decisions;
    }

    if (record.applyNetworkPolicyAmendment) {
      const amendment = asRecord(record.applyNetworkPolicyAmendment);
      decisions.push({
        kind: "applyNetworkPolicyAmendment",
        network_policy_amendment: amendment.network_policy_amendment,
      });
    }
    return decisions;
  }, []);
}

function approvalPermissions(approval: Approval): Record<string, unknown> {
  const permissions = asRecord(approval.payload).permissions;
  return permissions && typeof permissions === "object" ? (permissions as Record<string, unknown>) : {};
}

function defaultToolAnswers(payload: unknown): Record<string, { answers: string[] }> {
  const questions = asRecord(payload).questions;
  if (!Array.isArray(questions)) {
    return {};
  }

  return questions.reduce<Record<string, { answers: string[] }>>((answers, question) => {
    const record = asRecord(question);
    const id = stringValue(record.id);
    if (!id) {
      return answers;
    }
    const options = Array.isArray(record.options) ? record.options : [];
    const firstOption = asRecord(options[0]);
    const firstAnswer = stringValue(firstOption.label);
    answers[id] = { answers: firstAnswer ? [firstAnswer] : [] };
    return answers;
  }, {});
}

function approvalParsedActions(approval: Approval): string[] {
  const payload = asRecord(approval.payload);
  const commandActions = payload.commandActions;
  if (!Array.isArray(commandActions)) {
    return [];
  }

  return commandActions
    .map((action) => commandActionText(asRecord(action)))
    .filter((action): action is string => Boolean(action));
}

function commandActionText(action: Record<string, unknown>): string | null {
  const type = stringValue(action.type);
  const command = stringValue(action.command);
  if (type === "read") {
    const name = stringValue(action.name) ?? stringValue(action.path);
    return name ? `Read ${name}` : command;
  }
  if (type === "listFiles") {
    const path = stringValue(action.path);
    return path ? `List files in ${path}` : "List files";
  }
  if (type === "search") {
    const query = stringValue(action.query);
    const path = stringValue(action.path);
    if (query && path) {
      return `Search ${query} in ${path}`;
    }
    return query ? `Search ${query}` : command;
  }
  return command;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function execPolicyAmendmentValue(value: unknown): string[] | null {
  const array = stringArray(value);
  return array.length > 0 ? array : null;
}

function execPolicyAmendmentLabel(value: unknown): string {
  const array = stringArray(value);
  if (array.length > 0) {
    return array.join(" ");
  }
  const record = asRecord(value);
  const command = stringValue(record.command);
  return command ?? "this prefix";
}

function networkPolicyAmendments(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => stringValue(item.action) && stringValue(item.host)) : [];
}

function approvalNetworkHost(payload: Record<string, unknown>): string | null {
  return stringValue(asRecord(payload.networkApprovalContext).host);
}

function permissionRuleText(permissions: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (asRecord(permissions.network).enabled === true) {
    parts.push("network");
  }
  const fileSystem = asRecord(permissions.fileSystem ?? permissions.file_system);
  const readPaths = permissionPaths(fileSystem.read);
  const writePaths = permissionPaths(fileSystem.write);
  if (readPaths.length > 0) {
    parts.push(`read ${readPaths.join(", ")}`);
  }
  if (writePaths.length > 0) {
    parts.push(`write ${writePaths.join(", ")}`);
  }
  const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries.map(asRecord) : [];
  const entryReads = permissionEntryPaths(entries, "read");
  const entryWrites = permissionEntryPaths(entries, "write");
  const entryDeniedReads = permissionEntryPaths(entries, "none");
  if (entryReads.length > 0) {
    parts.push(`read ${entryReads.join(", ")}`);
  }
  if (entryWrites.length > 0) {
    parts.push(`write ${entryWrites.join(", ")}`);
  }
  if (entryDeniedReads.length > 0) {
    parts.push(`deny read ${entryDeniedReads.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function permissionPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)).map(formatPathToken) : [];
}

function permissionEntryPaths(entries: Record<string, unknown>[], access: string): string[] {
  return entries
    .filter((entry) => stringValue(entry.access) === access)
    .map((entry) => permissionEntryPathLabel(asRecord(entry.path)))
    .filter((item): item is string => Boolean(item));
}

function permissionEntryPathLabel(path: Record<string, unknown>): string | null {
  const directPath = stringValue(path.path);
  if (directPath) {
    return formatPathToken(directPath);
  }
  const pattern = stringValue(path.pattern);
  if (pattern) {
    return `glob \`${pattern}\``;
  }
  const value = asRecord(path.value);
  const kind = stringValue(value.kind);
  if (kind) {
    return formatPathToken(`:${kind}`);
  }
  return null;
}

function formatPathToken(path: string): string {
  return `\`${path}\``;
}

function firstQuestionText(payload: Record<string, unknown>): string | null {
  const questions = payload.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const firstQuestion = asRecord(questions[0]);
  return stringValue(firstQuestion.question) ?? stringValue(firstQuestion.header);
}

function isApprovalEvent(event: EventEnvelope): boolean {
  return event.kind === "approval.created" || event.kind === "approval.resolved";
}

function threadNameUpdateFromEvent(event: EventEnvelope): { threadId: string; name: string | null } | null {
  const method = (event.codexMethod ?? "").toLowerCase();
  if (method !== "thread/nameupdated" && method !== "thread/name_updated") {
    return null;
  }

  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId) ?? stringValue(payload.thread_id);
  if (!threadId) {
    return null;
  }

  return {
    threadId,
    name: stringValue(payload.threadName) ?? stringValue(payload.thread_name),
  };
}

function markThreadTitlePending(current: Set<string>, thread: ThreadSummary): Set<string> {
  if (isThreadTitleAvailable(thread)) {
    return current;
  }
  const next = new Set(current);
  next.add(thread.id);
  return next;
}

function clearAvailableThreadTitles(current: Set<string>, threads: ThreadSummary[]): Set<string> {
  let next: Set<string> | null = null;
  for (const thread of threads) {
    if (!current.has(thread.id) || !isThreadTitleAvailable(thread)) {
      continue;
    }
    next ??= new Set(current);
    next.delete(thread.id);
  }
  return next ?? current;
}

function prependThreadForProject(
  current: ThreadsByProjectId,
  projectId: string,
  thread: ThreadSummary,
): ThreadsByProjectId {
  return {
    ...current,
    [projectId]: [thread, ...(current[projectId] ?? [])],
  };
}

function removeThreadFromProjects(current: ThreadsByProjectId, threadId: string): ThreadsByProjectId {
  let changed = false;
  const next: ThreadsByProjectId = {};

  for (const [projectId, threads] of Object.entries(current)) {
    const projectThreads = threads.filter((thread) => thread.id !== threadId);
    next[projectId] = projectThreads;
    changed ||= projectThreads.length !== threads.length;
  }

  return changed ? next : current;
}

function replaceThreadInProjects(
  current: ThreadsByProjectId,
  thread: ThreadSummary,
  fallbackProjectId: string | null,
): ThreadsByProjectId {
  const projectId = projectIdForThread(current, thread, fallbackProjectId);
  if (!projectId) {
    return current;
  }

  return {
    ...current,
    [projectId]: (current[projectId] ?? []).map((item) => (item.id === thread.id ? thread : item)),
  };
}

function updateThreadNameInProjects(
  current: ThreadsByProjectId,
  threadId: string,
  name: string,
): ThreadsByProjectId {
  let changed = false;
  const next: ThreadsByProjectId = {};

  for (const [projectId, threads] of Object.entries(current)) {
    next[projectId] = threads.map((thread) => {
      if (thread.id !== threadId) {
        return thread;
      }
      changed = true;
      return { ...thread, name };
    });
  }

  return changed ? next : current;
}

function projectIdForThread(
  current: ThreadsByProjectId,
  thread: ThreadSummary,
  fallbackProjectId: string | null,
): string | null {
  const explicitProjectId = stringValue((thread as { projectId?: unknown }).projectId);
  if (explicitProjectId) {
    return explicitProjectId;
  }

  return Object.entries(current).find(([, threads]) => threads.some((item) => item.id === thread.id))?.[0] ?? fallbackProjectId;
}

function isThreadTitleAvailable(thread: ThreadSummary): boolean {
  const name = thread.name?.replace(/\s+/g, " ").trim();
  return Boolean(name && name !== UI_TEXT.thread.new);
}

function applyApprovalEvents(current: Approval[], events: EventEnvelope[]): Approval[] {
  return events.reduce(applyApprovalEvent, current);
}

function applyApprovalEvent(current: Approval[], event: EventEnvelope): Approval[] {
  const approval = approvalFromPayload(event.payload);
  if (!approval) {
    return current;
  }

  if (event.kind === "approval.resolved" || approval.status !== "pending") {
    return current.filter((item) => item.id !== approval.id);
  }

  const existing = current.findIndex((item) => item.id === approval.id);
  if (existing < 0) {
    return [...current, approval];
  }

  const copy = [...current];
  copy[existing] = approval;
  return copy;
}

function mergePendingApprovals(current: Approval[], fetched: Approval[]): Approval[] {
  const byId = new Map<string, Approval>();
  for (const approval of fetched) {
    byId.set(approval.id, approval);
  }
  for (const approval of current) {
    byId.set(approval.id, approval);
  }
  return Array.from(byId.values()).filter((approval) => approval.status === "pending");
}

function approvalFromPayload(payload: unknown): Approval | null {
  const record = asRecord(payload);
  if (!stringValue(record.id) || !stringValue(record.requestId) || !stringValue(record.method) || !stringValue(record.status)) {
    return null;
  }
  return record as Approval;
}

function threadDisplayTitle(thread: ThreadSummary): string {
  return (
    normalizeTitle(thread.name ?? null) ??
    normalizeTitle(previewTitle(thread.preview)) ??
    `${UI_TEXT.thread.untitled} ${thread.id.slice(0, 8)}`
  );
}

function threadNeedsApproval(thread: ThreadSummary, approvals: Approval[]): boolean {
  return approvals.some((approval) => approval.threadId === thread.id && approval.status === "pending") || threadStatusNeedsApproval(thread);
}

function threadStatusNeedsApproval(thread: ThreadSummary): boolean {
  return typeof thread.status === "string" && thread.status.toLowerCase().includes("approval");
}

function createThreadOptions(settings: ComposerSettings): CreateThreadOptions {
  const options: CreateThreadOptions = {};
  if (settings.model) {
    options.model = settings.model;
  }
  if (settings.fast) {
    options.serviceTier = "fast";
  }
  const permissions = permissionSettings(settings.permissionPreset);
  if (permissions) {
    options.approvalPolicy = permissions.approvalPolicy;
    options.approvalsReviewer = permissions.approvalsReviewer;
    options.sandbox = permissions.threadSandbox;
  }
  return options;
}

function composerTurnOptions(settings: ComposerSettings): TurnStartOptions {
  const options: TurnStartOptions = {};
  if (settings.model) {
    options.model = settings.model;
  }
  if (settings.effort) {
    options.effort = settings.effort;
  }
  if (settings.fast) {
    options.serviceTier = "fast";
  }
  const permissions = permissionSettings(settings.permissionPreset);
  if (permissions) {
    options.approvalPolicy = permissions.approvalPolicy;
    options.approvalsReviewer = permissions.approvalsReviewer;
    options.sandboxPolicy = permissions.turnSandboxPolicy;
  }
  return options;
}

function permissionSettings(preset: PermissionPresetId | undefined) {
  if (!preset) {
    return null;
  }

  if (preset === "fullAccess") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: { type: "dangerFullAccess" },
    };
  }

  return {
    approvalPolicy: "on-request",
    approvalsReviewer: preset === "autoReview" ? "auto_review" : "user",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [] },
  };
}

function contextUsageFromEvent(event: EventEnvelope): ContextUsage | null {
  if ((event.codexMethod ?? "").toLowerCase() !== "thread/tokenusage/updated") {
    return null;
  }

  const payload = asRecord(event.payload);
  const tokenUsage = asRecord(payload.tokenUsage ?? payload.token_usage ?? event.payload);
  const last = asRecord(tokenUsage.last);
  const total = asRecord(tokenUsage.total);
  const contextTokens =
    numberValue(last.totalTokens ?? last.total_tokens) ??
    numberValue(total.totalTokens ?? total.total_tokens ?? tokenUsage.totalTokens ?? tokenUsage.total_tokens);
  const modelContextWindow = numberValue(tokenUsage.modelContextWindow ?? tokenUsage.model_context_window);
  if (contextTokens === null && modelContextWindow === null) {
    return null;
  }
  return { contextTokens, modelContextWindow };
}

function sameComposerContext(left: ComposerContext | null, right: ComposerContext): boolean {
  return (
    left?.activeSelectedTurnId === right.activeSelectedTurnId &&
    left.draftThreadProjectId === right.draftThreadProjectId &&
    left.selectedProjectId === right.selectedProjectId &&
    left.selectedThreadId === right.selectedThreadId
  );
}

function accountInitial(label: string): string {
  return (label.trim().charAt(0) || "?").toUpperCase();
}

function previewTitle(preview: unknown): string | null {
  if (typeof preview === "string") {
    return preview;
  }
  if (preview && typeof preview === "object") {
    const payload = asRecord(preview);
    return stringValue(payload.text) ?? stringValue(payload.summary) ?? stringValue(payload.title);
  }
  return null;
}

function normalizeTitle(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function errorMessageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Gateway request failed";
}
