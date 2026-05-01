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
  FormEvent,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

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
import { TimelineActivityGroupRenderer, TimelineItemRenderer } from "./timeline/renderers";
import { applyTimelineEvent, createTimelineState, replayTimeline, type TimelineState } from "./timeline/reducer";
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

const SIDEBAR_MIN_WIDTH = 292;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 24;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function KodexShell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadsByProjectId, setThreadsByProjectId] = useState<ThreadsByProjectId>({});
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftThreadProjectId, setDraftThreadProjectId] = useState<string | null>(null);
  const [pendingTitleThreadIds, setPendingTitleThreadIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
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
  const resolvedApprovalIds = useRef<Set<string>>(new Set());
  const selectedProjectIdRef = useRef<string | null>(null);
  const threadRequestIds = useRef<Map<string, number>>(new Map());
  const nextThreadRequestId = useRef(0);

  const selectedProjectThreads = selectedProjectId ? threadsByProjectId[selectedProjectId] ?? [] : [];
  const selectedThread = selectedProjectThreads.find((thread) => thread.id === selectedThreadId) ?? null;
  const isDraftThreadSelected = draftThreadProjectId !== null && draftThreadProjectId === selectedProjectId;
  const canCompose = selectedThread !== null || isDraftThreadSelected;

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

  useEffect(() => {
    if (!selectedThreadId) {
      setTimeline(createTimelineState());
      return;
    }

    let cancelled = false;
    let closeStream: (() => void) | null = null;
    const threadId = selectedThreadId;

    listEvents(threadId)
      .then((events) => {
        if (cancelled) {
          return;
        }

        setApprovals((current) => applyApprovalEventsWithTombstone(current, events));
        applyThreadMetadataEvents(events);
        const replayedTimeline = replayTimeline(events.filter((event) => !isApprovalEvent(event)));
        setTimeline(replayedTimeline);
        const client = createEventStreamClient({
          cursor: replayedTimeline.lastSeq,
          threadId,
          onEvent: (event) => {
            if (event.threadId && event.threadId !== threadId) {
              return;
            }
            applyThreadMetadataEvent(event);
            if (isApprovalEvent(event)) {
              setApprovals((current) => applyApprovalEventWithTombstone(current, event));
              return;
            }
            setTimeline((current) => applyTimelineEvent(current, event));
          },
        });
        client.connect();
        closeStream = client.close;
      })
      .catch((error) => {
        if (!cancelled) {
          reportError(error);
        }
      });

    return () => {
      cancelled = true;
      closeStream?.();
    };
  }, [selectedThreadId]);

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
        setSelectedThreadId((current) =>
          current && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id ?? null,
        );
      }
    } catch (error) {
      if (threadRequestIds.current.get(projectId) === requestId) {
        reportError(error);
      }
    }
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
    setTimeline(createTimelineState());
    const nextThreads = threadsByProjectId[projectId];
    if (nextThreads) {
      setSelectedThreadId(nextThreads[0]?.id ?? null);
      return;
    }
    void loadProjectThreads(projectId, { selectWhenLoaded: true });
  }

  function handleCreateThread(projectId: string) {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(projectId);
    setSelectedThreadId(null);
    setTimeline(createTimelineState());
    setComposerText("");
  }

  function handleSelectThread(projectId: string, threadId: string) {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setDraftThreadProjectId(null);
    setSelectedThreadId(threadId);
  }

  async function handleArchiveThread() {
    if (!selectedThreadId) {
      return;
    }
    await archiveThread(selectedThreadId);
    setThreadsByProjectId((current) => removeThreadFromProjects(current, selectedThreadId));
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

  async function handleApprovalDecision(approval: Approval, decision: ApprovalResponse) {
    const resolved = await decideApproval(approval.id, decision);
    resolvedApprovalIds.current.add(resolved.id);
    setApprovals((current) => current.filter((item) => item.id !== approval.id));
  }

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
              <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-main-column">
                <Box className="kodex-thread-heading">
                  <Title
                    c={selectedThread && pendingTitleThreadIds.has(selectedThread.id) ? "dimmed" : undefined}
                    data-placeholder-title={selectedThread && pendingTitleThreadIds.has(selectedThread.id) ? "true" : undefined}
                    order={3}
                    size="h5"
                  >
                    {selectedThread
                      ? pendingTitleThreadIds.has(selectedThread.id)
                        ? UI_TEXT.thread.new
                        : threadDisplayTitle(selectedThread)
                      : UI_TEXT.thread.new}
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
              <Box className="kodex-timeline-scroll">
                <Box className="kodex-timeline-content">
                  {selectedThread ? (
                    <TimelineView
                      approvals={approvals.filter((approval) => approval.threadId === selectedThread.id)}
                      onApprovalDecision={handleApprovalDecision}
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
          <Box component="form" className="kodex-composer kodex-main-column" onSubmit={handleSubmitTurn}>
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
                  disabled={!selectedThread || !timeline.activeTurnId}
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
          {selectedThread && timeline.activeTurnId ? (
            <Box component="form" className="kodex-steer" onSubmit={handleSteerTurn}>
              <TextInput
                aria-label={UI_TEXT.turn.steer}
                placeholder={UI_TEXT.turn.steerPlaceholder}
                value={steerText}
                onChange={(event) => setSteerText(event.currentTarget.value)}
              />
              <Button type="submit" size="xs" disabled={!steerText.trim()}>
                {UI_TEXT.turn.steerSubmit}
              </Button>
            </Box>
          ) : null}
        </Stack>
      </AppShell.Main>
    </AppShell>
  );
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

function TimelineView({
  approvals,
  onApprovalDecision,
  showDebug,
  timeline,
}: {
  approvals: Approval[];
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  showDebug: boolean;
  timeline: TimelineState;
}) {
  const items = (showDebug ? [...timeline.items, ...timeline.hiddenItems] : timeline.items).sort(
    (left, right) => left.seq - right.seq,
  );
  const renderedItemIds = new Set(items.map((item) => item.id));
  const unanchoredApprovals = approvals.filter((approval) => !approval.itemId || !renderedItemIds.has(approval.itemId));

  if (items.length === 0) {
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

  return (
    <Stack gap="xs">
      {unanchoredApprovals.length > 0 ? (
        <ThreadApprovalStack approvals={unanchoredApprovals} onDecision={onApprovalDecision} />
      ) : null}
      {groupTimelineItems(items).map((group) => (
        <Box className="kodex-turn-group" key={group.key}>
          <Stack gap="xs">
            {timelineRenderSegments(group.items).map((segment) => {
              if (segment.type === "activity") {
                const itemIds = new Set(segment.items.map((item) => item.id));
                const activityApprovals = approvals.filter(
                  (approval) =>
                    approval.itemId !== undefined && approval.itemId !== null && itemIds.has(approval.itemId),
                );
                return (
                  <Box key={segment.key}>
                    <TimelineActivityGroupRenderer items={segment.items} showDebug={showDebug} />
                    {activityApprovals.length > 0 ? (
                      <Stack gap="xs" mt="xs">
                        {activityApprovals.map((approval) => (
                          <ApprovalCard approval={approval} key={approval.id} onDecision={onApprovalDecision} />
                        ))}
                      </Stack>
                    ) : null}
                  </Box>
                );
              }
              const itemApprovals = approvals.filter((approval) => approval.itemId === segment.item.id);
              return (
                <Box key={segment.key}>
                  <TimelineItemRenderer item={segment.item} showDebug={showDebug} />
                  {itemApprovals.length > 0 ? (
                    <Stack gap="xs" mt="xs">
                      {itemApprovals.map((approval) => (
                        <ApprovalCard approval={approval} key={approval.id} onDecision={onApprovalDecision} />
                      ))}
                    </Stack>
                  ) : null}
                </Box>
              );
            })}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function groupTimelineItems(items: TimelineState["items"]): Array<{ key: string; items: TimelineState["items"] }> {
  const groups: Array<{ key: string; items: TimelineState["items"] }> = [];
  for (const item of items) {
    const key = item.turnId ?? `item-${item.id}`;
    const current = groups[groups.length - 1];
    if (current?.key === key) {
      current.items.push(item);
    } else {
      groups.push({ key, items: [item] });
    }
  }
  return groups;
}

type TimelineRenderSegment =
  | { type: "activity"; key: string; items: TimelineState["items"] }
  | { type: "item"; key: string; item: TimelineState["items"][number] };

const timelineActivityKinds = new Set([
  "command_execution",
  "dynamic_tool_call",
  "file_change",
  "mcp_tool_call",
  "web_search_group",
]);

function timelineRenderSegments(items: TimelineState["items"]): TimelineRenderSegment[] {
  const segments: TimelineRenderSegment[] = [];
  let activityItems: TimelineState["items"] = [];

  function flushActivityItems() {
    if (activityItems.length === 0) {
      return;
    }
    segments.push({
      type: "activity",
      key: `activity-${activityItems.map((item) => item.id).join("-")}`,
      items: activityItems,
    });
    activityItems = [];
  }

  for (const item of items) {
    if (timelineActivityKinds.has(item.kind)) {
      activityItems.push(item);
      continue;
    }
    flushActivityItems();
    segments.push({ type: "item", key: item.id, item });
  }

  flushActivityItems();
  return segments;
}

function ThreadApprovalStack({
  approvals,
  onDecision,
}: {
  approvals: Approval[];
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  return (
    <Stack gap="xs" className="kodex-thread-approvals">
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
