import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  MantineProvider,
  Select,
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
  CheckCircle2,
  GitBranch,
  GitFork,
  Inbox,
  LogIn,
  MoreHorizontal,
  PanelRightOpen,
  Play,
  Send,
  Square,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  archiveThread,
  cancelLogin,
  createProject,
  createThread,
  decideApproval,
  forkThread,
  getAccount,
  getCapabilities,
  getRateLimits,
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
  type AccountResponse,
  type Approval,
  type ApprovalResponse,
  type Capabilities,
  type EventEnvelope,
  type ModelSummary,
  type Project,
  type RateLimitsResponse,
  type ThreadSummary,
} from "./api/client";
import { createEventStreamClient } from "./events/stream";
import { TimelineItemRenderer } from "./timeline/renderers";
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
  },
  capability: {
    appServer: "App-server",
    checking: "Checking gateway",
    gateway: "Gateway",
    offline: "offline",
    ready: "ready",
    trustedNetwork: "Trusted network",
    unavailable: "Gateway unavailable",
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
    noPreview: "No preview",
    noProjectsText: "Create a project to begin.",
    noProjectsTitle: "No projects",
    noThreadsText: "Start a thread for this project.",
    noThreadsTitle: "No threads",
    threadTimelineText: "Select or create a thread to view events, messages, tool calls, and warnings.",
    threadTimelineTitle: "Thread timeline",
  },
  model: "Model",
  mobile: {
    approvals: "Approvals",
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
    headerLabel: "Kodex",
    mainLabel: "Thread",
    workspaceLabel: "Workspace",
  },
  streamStatus: "Event stream",
  status: {
    debugEvents: "Show debug events",
    label: "Status",
    rateLimitUnavailable: "Rate limits unavailable",
  },
  thread: {
    archive: "Archive thread",
    fork: "Fork thread",
    new: "New thread",
    resume: "Resume thread",
    title: "Threads",
    untitled: "Untitled thread",
  },
  turn: {
    steer: "Steer active turn",
    steerPlaceholder: "Steer the active turn",
    steerSubmit: "Steer turn",
  },
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; capabilities: Capabilities }
  | { status: "error"; message: string };

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

type MobilePanel = "threads" | "chat" | "approvals";

function KodexShell() {
  const [capabilitiesState, setCapabilitiesState] = useState<LoadState>({ status: "loading" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineState>(createTimelineState());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitsResponse | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [loginState, setLoginState] = useState<LoginState>({});
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCwd, setProjectCwd] = useState("");
  const [composerText, setComposerText] = useState("");
  const [steerText, setSteerText] = useState("");
  const [streamStatus, setStreamStatus] = useState<"connected" | "reconnecting" | "closed">("closed");
  const [showDebugEvents, setShowDebugEvents] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const resolvedApprovalIds = useRef<Set<string>>(new Set());

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  useEffect(() => {
    loadInitialState();
  }, []);

  useEffect(() => {
    const client = createEventStreamClient({
      onEvent: (event) => {
        if (isApprovalEvent(event)) {
          setApprovals((current) => applyApprovalEventWithTombstone(current, event));
        }
      },
    });
    client.connect();
    return client.close;
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setThreads([]);
      setSelectedThreadId(null);
      return;
    }

    let cancelled = false;
    setThreads([]);
    setSelectedThreadId(null);

    listThreads(selectedProjectId)
      .then((nextThreads) => {
        if (cancelled) {
          return;
        }
        setThreads(nextThreads);
        setSelectedThreadId((current) =>
          current && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id ?? null,
        );
      })
      .catch((error) => {
        if (!cancelled) {
          reportError(error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

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
        const replayedTimeline = replayTimeline(events.filter((event) => !isApprovalEvent(event)));
        setTimeline(replayedTimeline);
        const client = createEventStreamClient({
          cursor: replayedTimeline.lastSeq,
          threadId,
          onEvent: (event) => {
            if (event.threadId && event.threadId !== threadId) {
              return;
            }
            if (isApprovalEvent(event)) {
              setApprovals((current) => applyApprovalEventWithTombstone(current, event));
              return;
            }
            setTimeline((current) => applyTimelineEvent(current, event));
          },
          onStatusChange: setStreamStatus,
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

  const modelOptions = useMemo(
    () => models.map((model) => ({ value: model.id, label: model.displayName })),
    [models],
  );

  async function loadInitialState() {
    try {
      const capabilities = await getCapabilities();
      setCapabilitiesState({ status: "ready", capabilities });
    } catch (error) {
      setCapabilitiesState({ status: "error", message: errorMessageFrom(error) });
      reportError(error);
    }

    const [nextProjects, nextApprovals, nextAccount, nextRateLimits, nextModels] = await Promise.allSettled([
      listProjects(),
      listPendingApprovals(),
      getAccount(),
      getRateLimits(),
      listModels(),
    ]);

    if (nextProjects.status === "fulfilled") {
      setProjects(nextProjects.value);
      setSelectedProjectId(nextProjects.value[0]?.id ?? null);
    } else {
      reportError(nextProjects.reason);
    }

    if (nextApprovals.status === "fulfilled") {
      setApprovals((current) =>
        mergePendingApprovals(
          current,
          nextApprovals.value.filter((approval) => !resolvedApprovalIds.current.has(approval.id)),
        ),
      );
    }

    if (nextAccount.status === "fulfilled") {
      setAccount(nextAccount.value);
    }

    if (nextRateLimits.status === "fulfilled") {
      setRateLimits(nextRateLimits.value);
    }

    if (nextModels.status === "fulfilled") {
      setModels(nextModels.value);
      setSelectedModel(nextModels.value.find((model) => model.isDefault)?.id ?? nextModels.value[0]?.id ?? null);
    }
  }

  async function handleCreateProject(event: FormEvent) {
    event.preventDefault();
    const project = await createProject({ name: projectName || null, cwd: projectCwd });
    setProjects((current) => [...current, project]);
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
    setSelectedProjectId(projectId);
    setThreads([]);
    setSelectedThreadId(null);
    setTimeline(createTimelineState());
    setStreamStatus("closed");
  }

  async function handleCreateThread() {
    if (!selectedProjectId) {
      return;
    }

    const thread = await createThread(selectedProjectId);
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
  }

  async function handleResumeThread() {
    if (!selectedThreadId) {
      return;
    }
    const thread = await resumeThread(selectedThreadId);
    upsertThread(thread);
  }

  async function handleForkThread() {
    if (!selectedThreadId) {
      return;
    }
    const thread = await forkThread(selectedThreadId);
    setThreads((current) => [thread, ...current]);
    setSelectedThreadId(thread.id);
  }

  async function handleArchiveThread() {
    if (!selectedThreadId) {
      return;
    }
    await archiveThread(selectedThreadId);
    setThreads((current) => current.filter((thread) => thread.id !== selectedThreadId));
    setSelectedThreadId(null);
  }

  async function handleSubmitTurn(event: FormEvent) {
    event.preventDefault();
    if (!selectedThreadId || !composerText.trim()) {
      return;
    }

    const text = composerText.trim();
    await startTurn(selectedThreadId, text);
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

  function upsertThread(thread: ThreadSummary) {
    setThreads((current) => {
      const existing = current.findIndex((item) => item.id === thread.id);
      if (existing < 0) {
        return [thread, ...current];
      }
      const copy = [...current];
      copy[existing] = thread;
      return copy;
    });
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

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 292, breakpoint: "sm" }}
      aside={{ width: 340, breakpoint: "md" }}
      padding="md"
      className="kodex-shell"
      data-mobile-panel={mobilePanel}
    >
      <AppShell.Header aria-label={UI_TEXT.shell.headerLabel} className="kodex-header">
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Box className="kodex-mark" aria-hidden="true">
              K
            </Box>
            <Title order={1} size="h3">
              {UI_TEXT.appName}
            </Title>
          </Group>
          <Group gap="sm" wrap="nowrap" className="kodex-header-controls">
            <Select
              aria-label={UI_TEXT.model}
              data={modelOptions}
              value={selectedModel}
              onChange={setSelectedModel}
              size="xs"
              w={150}
              disabled={modelOptions.length === 0}
            />
            <AccountControls
              account={account}
              loginState={loginState}
              onCancelLogin={handleCancelLogin}
              onLogin={handleLogin}
              onLogout={handleLogout}
            />
            <HeaderStatusMenu
              capabilitiesState={capabilitiesState}
              onShowDebugEventsChange={setShowDebugEvents}
              rateLimits={rateLimits}
              showDebugEvents={showDebugEvents}
            />
          </Group>
        </Group>
      </AppShell.Header>
      <MobilePanelSwitcher activePanel={mobilePanel} approvalsCount={approvals.length} onChange={setMobilePanel} />

      <AppShell.Navbar aria-label={UI_TEXT.shell.workspaceLabel} p="md" className="kodex-sidebar">
        <Stack gap="lg" h="100%">
          <Box>
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
            <Stack gap="xs">
              {projects.length === 0 ? (
                <EmptyPanel icon={<Inbox size={20} />} title={UI_TEXT.empty.noProjectsTitle} text={UI_TEXT.empty.noProjectsText} />
              ) : (
                projects.map((project) => (
                  <button
                    className="kodex-list-button"
                    data-active={project.id === selectedProjectId}
                    key={project.id}
                    onClick={() => handleSelectProject(project.id)}
                    type="button"
                  >
                    <Text fw={700} size="sm">
                      {project.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {project.cwd}
                    </Text>
                  </button>
                ))
              )}
            </Stack>
          </Box>
          <Box>
            <Group justify="space-between" align="center" mb="sm">
              <Text fw={700} size="sm">
                {UI_TEXT.thread.title}
              </Text>
              <Button size="xs" variant="light" onClick={handleCreateThread} disabled={!selectedProject}>
                {UI_TEXT.thread.new}
              </Button>
            </Group>
            <Stack gap="xs">
              {threads.length === 0 ? (
                <EmptyPanel icon={<Inbox size={20} />} title={UI_TEXT.empty.noThreadsTitle} text={UI_TEXT.empty.noThreadsText} />
              ) : (
                threads.map((thread) => (
                  <button
                    className="kodex-list-button"
                    data-active={thread.id === selectedThreadId}
                    key={thread.id}
                    onClick={() => setSelectedThreadId(thread.id)}
                    type="button"
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={700} size="sm" lineClamp={2}>
                        {threadDisplayTitle(thread)}
                      </Text>
                      <Badge className="kodex-thread-status" size="xs" variant="light">
                        {threadStatusLabel(thread.status)}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {previewText(thread.preview)}
                    </Text>
                  </button>
                ))
              )}
            </Stack>
          </Box>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main aria-label={UI_TEXT.shell.mainLabel} className="kodex-main">
        <Stack h="calc(100vh - 88px)" gap="md">
          {errorMessage ? (
            <Badge color="red" variant="light" leftSection={<AlertCircle size={12} />}>
              {errorMessage}
            </Badge>
          ) : null}
          {selectedThread ? (
            <Badge color={streamStatus === "reconnecting" ? "yellow" : "gray"} variant="light">
              {UI_TEXT.streamStatus} {streamStatus}
            </Badge>
          ) : null}
          <Box className="kodex-thread-panel">
            {selectedThread ? (
              <Stack gap="md" h="100%" className="kodex-thread-layout">
                <Group justify="space-between" wrap="nowrap" className="kodex-thread-header">
                  <Box className="kodex-thread-heading">
                    <Title order={2} size="h4">
                      {threadDisplayTitle(selectedThread)}
                    </Title>
                    <Text size="sm" c="dimmed">
                      {selectedProject?.cwd ?? selectedThread.cwd}
                    </Text>
                  </Box>
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label={UI_TEXT.thread.resume}>
                      <ActionIcon aria-label={UI_TEXT.thread.resume} variant="subtle" onClick={handleResumeThread}>
                        <Play size={17} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={UI_TEXT.thread.fork}>
                      <ActionIcon aria-label={UI_TEXT.thread.fork} variant="subtle" onClick={handleForkThread}>
                        <GitFork size={17} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={UI_TEXT.thread.archive}>
                      <ActionIcon aria-label={UI_TEXT.thread.archive} variant="subtle" onClick={handleArchiveThread}>
                        <Archive size={17} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
                <Box className="kodex-timeline-scroll">
                  <TimelineView
                    approvals={approvals.filter((approval) => approval.threadId === selectedThread.id)}
                    onApprovalDecision={handleApprovalDecision}
                    showDebug={showDebugEvents}
                    timeline={timeline}
                  />
                </Box>
              </Stack>
            ) : (
              <EmptyPanel
                icon={<PanelRightOpen size={22} />}
                title={UI_TEXT.empty.threadTimelineTitle}
                text={UI_TEXT.empty.threadTimelineText}
              />
            )}
          </Box>
          <Box component="form" className="kodex-composer" onSubmit={handleSubmitTurn}>
            <Textarea
              aria-label="Message composer"
              placeholder={selectedThread ? UI_TEXT.composer.placeholder : UI_TEXT.composer.disabledPlaceholder}
              minRows={2}
              autosize
              value={composerText}
              onChange={(event) => setComposerText(event.currentTarget.value)}
              disabled={!selectedThread}
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
                  disabled={!selectedThread || !composerText.trim()}
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

      <AppShell.Aside aria-label={UI_TEXT.approvals.label} p="md" className="kodex-approvals">
        <ApprovalPanel approvals={approvals} onDecision={handleApprovalDecision} />
      </AppShell.Aside>
    </AppShell>
  );
}

function CapabilitySummary({ state }: { state: LoadState }) {
  if (state.status === "loading") {
    return (
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          {UI_TEXT.capability.checking}
        </Text>
      </Group>
    );
  }

  if (state.status === "error") {
    return (
      <Badge color="red" leftSection={<AlertCircle size={12} />} variant="light">
        {UI_TEXT.capability.unavailable}
      </Badge>
    );
  }

  const { gateway, appServer } = state.capabilities;

  return (
    <Group gap="xs" wrap="nowrap">
      <Badge variant="light" color="teal">
        {UI_TEXT.capability.gateway} {gateway.version}
      </Badge>
      <Badge variant="light" color={appServer.ready ? "green" : "yellow"}>
        {UI_TEXT.capability.appServer} {appServer.ready ? UI_TEXT.capability.ready : UI_TEXT.capability.offline}
      </Badge>
      {gateway.trustedNetworkOnly ? (
        <Badge variant="light" color="blue">
          {UI_TEXT.capability.trustedNetwork}
        </Badge>
      ) : null}
    </Group>
  );
}

function RateLimitSummary({ rateLimits }: { rateLimits: RateLimitsResponse | null }) {
  const primary = rateLimits?.rateLimits?.primary;
  if (!primary) {
    return (
      <Text size="xs" c="dimmed">
        {UI_TEXT.status.rateLimitUnavailable}
      </Text>
    );
  }

  return (
    <Badge variant="light" color="violet">
      {primary.usedPercent}% used
    </Badge>
  );
}

function HeaderStatusMenu({
  capabilitiesState,
  onShowDebugEventsChange,
  rateLimits,
  showDebugEvents,
}: {
  capabilitiesState: LoadState;
  onShowDebugEventsChange: (value: boolean) => void;
  rateLimits: RateLimitsResponse | null;
  showDebugEvents: boolean;
}) {
  return (
    <Menu position="bottom-end" width={260} withinPortal>
      <Menu.Target>
        <Button
          aria-label={UI_TEXT.status.label}
          className="kodex-status-button"
          leftSection={<MoreHorizontal size={14} />}
          size="xs"
          variant="subtle"
        >
          {UI_TEXT.status.label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Stack gap="xs" p="xs">
          <CapabilitySummary state={capabilitiesState} />
          <RateLimitSummary rateLimits={rateLimits} />
        </Stack>
        <Menu.Divider />
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

function MobilePanelSwitcher({
  activePanel,
  approvalsCount,
  onChange,
}: {
  activePanel: MobilePanel;
  approvalsCount: number;
  onChange: (panel: MobilePanel) => void;
}) {
  const tabs: Array<{ label: string; panel: MobilePanel }> = [
    { label: UI_TEXT.mobile.threads, panel: "threads" },
    { label: UI_TEXT.mobile.chat, panel: "chat" },
    { label: `${UI_TEXT.mobile.approvals}${approvalsCount > 0 ? ` ${approvalsCount}` : ""}`, panel: "approvals" },
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

function AccountControls({
  account,
  loginState,
  onCancelLogin,
  onLogin,
  onLogout,
}: {
  account: AccountResponse | null;
  loginState: LoginState;
  onCancelLogin: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  if (account?.account) {
    return (
      <Group className="kodex-account-controls" gap="xs" wrap="nowrap">
        <Badge variant="light" color="green">
          {account.account.email ?? account.account.accountType}
        </Badge>
        <Button className="kodex-account-secondary" size="xs" variant="subtle" onClick={onLogout}>
          {UI_TEXT.auth.logout}
        </Button>
      </Group>
    );
  }

  return (
    <Group className="kodex-account-controls" gap="xs" wrap="nowrap">
      <Button className="kodex-account-primary" leftSection={<LogIn size={14} />} size="xs" variant="light" onClick={onLogin}>
        {UI_TEXT.auth.connect}
      </Button>
      {loginState.authUrl ? (
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
      {loginState.loginId ? (
        <Button className="kodex-account-secondary" size="xs" variant="subtle" color="gray" onClick={onCancelLogin}>
          {UI_TEXT.auth.cancel}
        </Button>
      ) : null}
    </Group>
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

  if (items.length === 0) {
    return (
      <EmptyPanel
        icon={<PanelRightOpen size={22} />}
        title={UI_TEXT.empty.noEventsTitle}
        text={UI_TEXT.empty.noEventsText}
      />
    );
  }

  return (
    <Stack gap="xs">
      {groupTimelineItems(items).map((group) => (
        <Box className="kodex-turn-group" key={group.key}>
          <Stack gap="xs">
            {group.items.map((item) => {
              const itemApprovals = approvals.filter((approval) => approval.itemId === item.id);
              return (
                <Box key={item.id}>
                  <TimelineItemRenderer item={item} showDebug={showDebug} />
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

function ApprovalPanel({
  approvals,
  onDecision,
}: {
  approvals: Approval[];
  onDecision: (approval: Approval, decision: ApprovalResponse) => void;
}) {
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text fw={700} size="sm">
          {UI_TEXT.approvals.label}
        </Text>
        <Badge variant="light" color={approvals.length > 0 ? "orange" : "gray"}>
          {approvals.length} {UI_TEXT.approvals.pending}
        </Badge>
      </Group>
      {approvals.length === 0 ? (
        <EmptyPanel
          icon={<CheckCircle2 size={20} />}
          title={UI_TEXT.approvals.emptyTitle}
          text={UI_TEXT.approvals.emptyText}
        />
      ) : (
        approvals.map((approval) => (
          <ApprovalCard approval={approval} key={approval.id} onDecision={onDecision} />
        ))
      )}
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
      <Text size="xs" c="dimmed">
        {approvalDetail(approval)}
      </Text>
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
  return stringValue(payload.command) ?? stringValue(payload.path) ?? stringValue(payload.message) ?? firstQuestionText(payload);
}

function approvalDetail(approval: Approval): string {
  const payload = asRecord(approval.payload);
  return [stringValue(payload.cwd), stringValue(payload.reason)].filter(Boolean).join(" - ") || approval.method;
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

function previewText(preview: unknown): string {
  if (typeof preview === "string") {
    return preview;
  }
  if (preview && typeof preview === "object") {
    return JSON.stringify(preview);
  }
  return UI_TEXT.empty.noPreview;
}

function threadDisplayTitle(thread: ThreadSummary): string {
  return (
    truncateTitle(thread.name ?? null) ??
    truncateTitle(previewTitle(thread.preview)) ??
    `${UI_TEXT.thread.untitled} ${thread.id.slice(0, 8)}`
  );
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

function truncateTitle(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function threadStatusLabel(status: string): string {
  return status.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
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
