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
  PanelRightOpen,
  Send,
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
  listPendingApprovals,
  listProjects,
  listThreads,
  logout,
  resumeThread,
  startLogin,
  startTurn,
  steerTurn,
  type AccountResponse,
  type Approval,
  type ApprovalResponse,
  type EventEnvelope,
  type Project,
  type ThreadSummary,
} from "./api/client";
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
import { createTimelineState, replayTimeline, type TimelineState } from "./timeline/reducer";
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
    commandTitle: "Command approval",
    emptyText: "Command, file, and permission requests will appear here.",
    emptyTitle: "No pending approvals",
    fallbackTitle: "Approval request",
    fileTitle: "File change approval",
    label: "Approvals",
    mcpTitle: "MCP approval",
    permissionsTitle: "Permission approval",
    pending: "pending",
    toolInputTitle: "Input requested",
    actions: {
      accept: "Accept",
      acceptAria: "Accept approval",
      acceptSession: "Session",
      acceptSessionAria: "Accept for session",
      applyExecPolicy: "Apply exec policy",
      applyExecPolicyAria: "Apply exec policy approval",
      cancel: "Cancel",
      cancelAria: "Cancel approval",
      decline: "Decline",
      declineAria: "Decline approval",
      grant: "Grant",
      grantAria: "Grant approval",
      grantSession: "Session",
      grantSessionAria: "Grant for session",
      submit: "Submit",
      submitAria: "Submit answers",
    },
  },
  auth: {
    cancel: "Cancel login",
    connect: "Connect ChatGPT",
    logout: "Logout",
    open: "Open ChatGPT auth",
    settings: "Account settings",
  },
  composer: {
    disabledPlaceholder: "Select a thread to start composing",
    placeholder: "Message Kodex",
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
    steer: "Steer active turn",
    steerPlaceholder: "Steer the active turn",
    steerSubmit: "Steer turn",
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

const SIDEBAR_MIN_WIDTH = 292;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 24;
const EMPTY_APPROVALS: Approval[] = [];
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
  const [loginState, setLoginState] = useState<LoginState>({});
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCwd, setProjectCwd] = useState("");
  const [composerText, setComposerText] = useState("");
  const [steerText, setSteerText] = useState("");
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
  const expectsSteerComposer =
    selectedThread !== null && (timeline.activeTurnId !== null || threadStatusMayHaveActiveTurn(selectedThread));
  const shouldShowSteerComposer = selectedThread !== null && isSelectedTimelineReady && timeline.activeTurnId !== null;
  const shouldReserveSteerComposer = selectedThread !== null && !isSelectedTimelineReady && expectsSteerComposer;
  const isDraftThreadSelected = draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId;
  const canCompose = selectedThread !== null || isDraftThreadSelected;
  const selectedThreadTitle = selectedThread
    ? pendingTitleThreadIds.has(selectedThread.id)
      ? UI_TEXT.thread.new
      : threadDisplayTitle(selectedThread)
    : UI_TEXT.thread.new;

  useEffect(() => {
    loadInitialState();
  }, []);

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
      if (nextThreadId) {
        beginTimelineEntry(nextThreadId);
      } else {
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
    setSelectedThreadId(null);
    clearTimelineEntry();
    setComposerText("");
  }

  function handleSelectThread(projectId: string, threadId: string) {
    if (projectId === selectedProjectId && threadId === selectedThreadId) {
      return;
    }
    selectedProjectIdRef.current = projectId;
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
    if (!composerText.trim()) {
      return;
    }

    const text = composerText.trim();
    if (selectedThreadId) {
      await startTurn(selectedThreadId, text);
      setComposerText("");
      return;
    }

    if (!isDraftThreadSelected || !selectedProjectId) {
      return;
    }

    const thread = await createThread(selectedProjectId);
    setThreadsByProjectId((current) => prependThreadForProject(current, selectedProjectId, thread));
    setPendingTitleThreadIds((current) => markThreadTitlePending(current, thread));
    setDraftThreadProjectId(null);
    beginTimelineEntry(thread.id);
    setSelectedThreadId(thread.id);
    await startTurn(thread.id, text);
    setComposerText("");
  }

  async function handleStopTurn() {
    if (!selectedThreadId || !timeline.activeTurnId) {
      return;
    }

    await interruptTurn(selectedThreadId, timeline.activeTurnId);
  }

  async function handleSteerTurn(event: FormEvent) {
    event.preventDefault();
    if (!selectedThreadId || !timeline.activeTurnId || !steerText.trim()) {
      return;
    }

    await steerTurn(selectedThreadId, timeline.activeTurnId, steerText.trim());
    setSteerText("");
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
            component="form"
            className="kodex-composer kodex-main-column"
            data-entry-ready={selectedThread !== null && !isSelectedTimelineReady ? "false" : "true"}
            onSubmit={handleSubmitTurn}
          >
            <Textarea
              aria-label="Message composer"
              placeholder={canCompose ? UI_TEXT.composer.placeholder : UI_TEXT.composer.disabledPlaceholder}
              minRows={2}
              autosize
              value={composerText}
              onChange={(event) => setComposerText(event.currentTarget.value)}
              disabled={!canCompose}
            />
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={UI_TEXT.composer.stop}>
                <ActionIcon
                  aria-label={UI_TEXT.composer.stop}
                  size="lg"
                  variant="light"
                  disabled={!selectedThread || !isSelectedTimelineReady || !timeline.activeTurnId}
                  onClick={handleStopTurn}
                >
                  <Square size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={UI_TEXT.composer.send}>
                <ActionIcon
                  aria-label={UI_TEXT.composer.send}
                  size="lg"
                  type="submit"
                  disabled={!canCompose || !composerText.trim()}
                >
                  <Send size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Box>
          {shouldShowSteerComposer || shouldReserveSteerComposer ? (
            <SteerComposer
              hidden={shouldReserveSteerComposer}
              onSteerTextChange={setSteerText}
              onSubmit={handleSteerTurn}
              steerText={steerText}
            />
          ) : null}
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
    beginEntry(threadId);

    listEvents(threadId)
      .then((events) => {
        if (cancelled) {
          return;
        }

        setApprovals((current) => latestCallbacks.current.onApprovalEvents(current, events));
        latestCallbacks.current.onThreadMetadataEvents(events);
        const replayedTimeline = replayTimeline(events.filter((event) => !isApprovalEvent(event)));
        setTimeline(replayedTimeline);
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

function SteerComposer({
  hidden = false,
  onSteerTextChange,
  onSubmit,
  steerText,
}: {
  hidden?: boolean;
  onSteerTextChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  steerText: string;
}) {
  return (
    <Box
      aria-hidden={hidden || undefined}
      className={hidden ? "kodex-steer kodex-steer-placeholder" : "kodex-steer"}
      component="form"
      onSubmit={hidden ? (event) => event.preventDefault() : onSubmit}
    >
      <TextInput
        aria-label={hidden ? undefined : UI_TEXT.turn.steer}
        disabled={hidden}
        placeholder={UI_TEXT.turn.steerPlaceholder}
        tabIndex={hidden ? -1 : undefined}
        value={hidden ? "" : steerText}
        onChange={(event) => onSteerTextChange(event.currentTarget.value)}
      />
      <Button type="submit" size="xs" disabled={hidden || !steerText.trim()} tabIndex={hidden ? -1 : undefined}>
        {UI_TEXT.turn.steerSubmit}
      </Button>
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
  onApprovalDecision,
  onReady,
  scrollParentElement,
  showDebug,
  timeline,
}: {
  approvals: Approval[];
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
  onApprovalDecision,
  row,
  showDebug,
}: {
  approvals: Approval[];
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
        <TimelineItemRenderer item={row.item} showDebug={showDebug} />
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
  const isCommandApproval = normalizedApprovalMethod(approval.method) === "command";

  return (
    <Box className="kodex-approval-card">
      <Text fw={700} size="sm">
        {approvalTitle(approval)}
      </Text>
      {subject ? (
        isCommandApproval ? (
          <Box className="kodex-approval-command" component="code">
            {subject}
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
            key={action.ariaLabel}
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
  switch (normalizedApprovalMethod(approval.method)) {
    case "command":
      return UI_TEXT.approvals.commandTitle;
    case "file":
      return UI_TEXT.approvals.fileTitle;
    case "permissions":
      return UI_TEXT.approvals.permissionsTitle;
    case "mcp_elicitation":
      return UI_TEXT.approvals.mcpTitle;
    case "tool_user_input":
      return UI_TEXT.approvals.toolInputTitle;
    default:
      return UI_TEXT.approvals.fallbackTitle;
  }
}

function approvalSubject(approval: Approval): string | null {
  const payload = asRecord(approval.payload);
  return (
    stringValue(payload.command) ??
    stringValue(payload.path) ??
    stringValue(payload.message) ??
    firstQuestionText(payload) ??
    stringValue(payload.reason)
  );
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
  const copy = UI_TEXT.approvals.actions;

  if (method === "permissions") {
    const permissions = approvalPermissions(approval);
    return [
      {
        ariaLabel: copy.grantAria,
        icon: <Check size={14} />,
        label: copy.grant,
        response: { permissions, scope: "turn" },
      },
      {
        ariaLabel: copy.grantSessionAria,
        icon: <Check size={14} />,
        label: copy.grantSession,
        response: { permissions, scope: "session" },
        variant: "light",
      },
    ];
  }

  if (method === "mcp_elicitation") {
    return [
      {
        ariaLabel: copy.acceptAria,
        icon: <Check size={14} />,
        label: copy.accept,
        response: { action: "accept" },
      },
      {
        ariaLabel: copy.declineAria,
        color: "red",
        icon: <X size={14} />,
        label: copy.decline,
        response: { action: "decline" },
        variant: "light",
      },
      {
        ariaLabel: copy.cancelAria,
        color: "gray",
        icon: <X size={14} />,
        label: copy.cancel,
        response: { action: "cancel" },
        variant: "subtle",
      },
    ];
  }

  if (method === "tool_user_input") {
    return [
      {
        ariaLabel: copy.submitAria,
        icon: <Check size={14} />,
        label: copy.submit,
        response: { answers: defaultToolAnswers(approval.payload) },
      },
    ];
  }

  if (method === "command") {
    return [...basicCommandOrFileActions(), ...commandAmendmentActions(approval)];
  }

  if (method === "file") {
    return basicCommandOrFileActions();
  }

  return [];
}

function basicCommandOrFileActions(): ApprovalAction[] {
  const copy = UI_TEXT.approvals.actions;
  return [
      {
        ariaLabel: copy.acceptAria,
        icon: <Check size={14} />,
        label: copy.accept,
        response: { decision: "accept" },
      },
      {
        ariaLabel: copy.acceptSessionAria,
        icon: <Check size={14} />,
        label: copy.acceptSession,
        response: { decision: "acceptForSession" },
        variant: "light",
      },
      {
        ariaLabel: copy.declineAria,
        color: "red",
        icon: <X size={14} />,
        label: copy.decline,
        response: { decision: "decline" },
        variant: "light",
      },
      {
        ariaLabel: copy.cancelAria,
        color: "gray",
        icon: <X size={14} />,
        label: copy.cancel,
        response: { decision: "cancel" },
        variant: "subtle",
      },
  ];
}

function commandAmendmentActions(approval: Approval): ApprovalAction[] {
  const payload = asRecord(approval.payload);
  const actions: ApprovalAction[] = [];
  const execpolicyAmendment = stringArray(payload.proposedExecpolicyAmendment);

  if (execpolicyAmendment.length > 0) {
    actions.push({
      ariaLabel: UI_TEXT.approvals.actions.applyExecPolicyAria,
      icon: <Check size={14} />,
      label: UI_TEXT.approvals.actions.applyExecPolicy,
      response: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: execpolicyAmendment,
          },
        },
      },
      variant: "light",
    });
  }

  for (const amendment of networkPolicyAmendments(payload.proposedNetworkPolicyAmendments)) {
    const action = stringValue(amendment.action) ?? "apply";
    const host = stringValue(amendment.host) ?? "host";
    actions.push({
      ariaLabel: `Apply ${action} policy for ${host}`,
      icon: <Check size={14} />,
      label: `${capitalize(action)} ${host}`,
      response: {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: amendment,
          },
        },
      },
      variant: "light",
    });
  }

  return actions;
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

function networkPolicyAmendments(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => stringValue(item.action) && stringValue(item.host)) : [];
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

function threadStatusMayHaveActiveTurn(thread: ThreadSummary): boolean {
  if (typeof thread.status !== "string") {
    return false;
  }
  const status = thread.status.toLowerCase();
  return status.includes("running") || status.includes("active");
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

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function errorMessageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Gateway request failed";
}
