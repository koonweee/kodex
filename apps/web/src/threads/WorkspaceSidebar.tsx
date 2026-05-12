import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  Archive,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { AccountResponse, Approval, Project, ThreadSummary } from "../api/client";
import type { UsageLimitLines } from "../account/rateLimits";
import { SidebarAccountFooter, type LoginState } from "../account/SidebarAccountFooter";
import { EmptyPanel } from "../ui/EmptyPanel";
import {
  threadDisplayTitle,
  threadInProgress,
  threadNeedsApproval,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  type ThreadsByProjectId,
} from "./helpers";
import { moveProjectInSidebarOrderAt } from "./projectOrder";
import { SidebarActionDisclosureRow, SidebarRowFrame, SidebarSectionDisclosureRow } from "./sidebarRows";

const SIDEBAR_TEXT = {
  cancelLogin: "Cancel login",
  chats: "Chats",
  createProject: "Add project",
  cwd: "Directory",
  newChat: "New chat",
  newProject: "Add project",
  newThread: "New thread",
  noProjectsText: "Create a project to begin.",
  noProjectsTitle: "No projects",
  automations: "Automations",
  pinned: "Pinned",
  pinThread: "Pin thread",
  projects: "Projects",
  resizeSidebarLabel: "Resize workspace sidebar",
  search: "Search",
  startNewChatDesktop: "Start new chat from desktop header",
  startNewChatMobile: "Start new chat from mobile header",
  showThread: "Show thread",
  showLessThreads: "Show less",
  showMoreThreads: "Show more",
  threadInProgress: "Thread in progress",
  unreadAgentTurn: "Unread completed agent turn",
  unpinThread: "Unpin thread",
  workspaceLabel: "Workspace",
};

const VISIBLE_THREAD_LIMIT = 5;
type SidebarDataLoadState = "error" | "loaded" | "loading" | "refetching";

export type WorkspaceSidebarDataState = {
  chatThreads: SidebarDataLoadState;
  pinnedThreads: SidebarDataLoadState;
  projects: SidebarDataLoadState;
  projectThreadsById: Record<string, SidebarDataLoadState>;
};

const DEFAULT_DATA_STATE: WorkspaceSidebarDataState = {
  chatThreads: "loaded",
  pinnedThreads: "loaded",
  projects: "loaded",
  projectThreadsById: {},
};

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  account,
  approvals,
  chatThreads,
  dataState = DEFAULT_DATA_STATE,
  hoveredThreadActionId,
  isSidebarResizing,
  loginState,
  onArchiveThread,
  onCancelLogin,
  onCreateChat,
  onCreateProject,
  onCreateThread,
  onLogin,
  onLogout,
  onOpenPreferences,
  onPinThread,
  onProjectCwdChange,
  onProjectDirectoryCreateCancel,
  onProjectFormOpenChange,
  onReorderProjects,
  onSelectAutomations,
  onSelectChatThread,
  onSelectPinnedThread,
  onSelectProjectSettings,
  onSelectThread,
  onShowThread = () => undefined,
  onShowDebugEventsChange,
  onSidebarResizeKeyDown,
  onSidebarResizePointerDown,
  onThreadActionHoverChange,
  onUnpinThread,
  pinnedThreads,
  pendingTitleThreadIds,
  projectCwd,
  projectDirectoryCreatePending,
  projectFormOpen,
  projects,
  selectedProjectId,
  selectedMainPane,
  selectedThreadId,
  showDebugEvents,
  sidebarWidth,
  threadsByProjectId,
  usageLimitLines,
}: {
  account: AccountResponse | null;
  approvals: Approval[];
  chatThreads: ThreadSummary[];
  dataState?: WorkspaceSidebarDataState;
  hoveredThreadActionId: string | null;
  isSidebarResizing: boolean;
  loginState: LoginState;
  onArchiveThread: (threadId: string) => void;
  onCancelLogin: () => void;
  onCreateChat: () => void;
  onCreateProject: (options?: { createDirectory?: boolean }) => void;
  onCreateThread: (projectId: string) => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenPreferences: () => void;
  onPinThread: (threadId: string) => void;
  onProjectCwdChange: (value: string) => void;
  onProjectDirectoryCreateCancel: () => void;
  onProjectFormOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  onReorderProjects: (projectIds: string[]) => void;
  onSelectAutomations: () => void;
  onSelectChatThread: (threadId: string) => void;
  onSelectPinnedThread: (threadId: string) => void;
  onSelectProjectSettings: (projectId: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onShowThread?: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  onSidebarResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSidebarResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  pinnedThreads: ThreadSummary[];
  projectCwd: string;
  projectDirectoryCreatePending: boolean;
  projectFormOpen: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  selectedMainPane: "thread" | "automations" | "project";
  selectedThreadId: string | null;
  showDebugEvents: boolean;
  sidebarWidth: number;
  threadsByProjectId: ThreadsByProjectId;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [chatThreadsExpanded, setChatThreadsExpanded] = useState(false);
  const [chatsSectionCollapsed, setChatsSectionCollapsed] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedThreadProjectIds, setExpandedThreadProjectIds] = useState<Set<string>>(() => new Set());
  const [mobileSidebarScope, setMobileSidebarScope] = useState<"projects" | "chats">("projects");
  const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false);
  const [previewProjectIds, setPreviewProjectIds] = useState<string[] | null>(null);
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const isMobileSidebar = useMediaQuery("(max-width: 900px)", false);
  const hasCoarsePointer = useMediaQuery("(any-pointer: coarse)", false);
  const useTouchDensity = isMobileSidebar || hasCoarsePointer;
  const projectGroupRefs = useRef<Map<string, HTMLElement>>(new Map());
  const pendingProjectAnimationRects = useRef<Map<string, DOMRect> | null>(null);
  const displayedProjects = useMemo(
    () => projectsFromPreviewOrder(projects, previewProjectIds),
    [previewProjectIds, projects],
  );
  const sortedChatThreads = useMemo(
    () => sortThreadsForSidebar(chatThreads, approvals, pendingTitleThreadIds),
    [approvals, chatThreads, pendingTitleThreadIds],
  );
  const sortedPinnedThreads = useMemo(
    () => sortPinnedThreadsForSidebar(pinnedThreads, approvals, pendingTitleThreadIds),
    [approvals, pendingTitleThreadIds, pinnedThreads],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visiblePinnedThreads = normalizedSearchQuery
    ? sortedPinnedThreads.filter((thread) => threadMatchesSearch(thread, normalizedSearchQuery, pendingTitleThreadIds))
    : sortedPinnedThreads;
  const visibleChatThreads = normalizedSearchQuery
    ? sortedChatThreads.filter((thread) => threadMatchesSearch(thread, normalizedSearchQuery, pendingTitleThreadIds))
    : sortedChatThreads;

  useLayoutEffect(() => {
    const beforeRects = pendingProjectAnimationRects.current;
    pendingProjectAnimationRects.current = null;
    if (!beforeRects) {
      return;
    }
    for (const project of displayedProjects) {
      const element = projectGroupRefs.current.get(project.id);
      const before = beforeRects.get(project.id);
      if (!element || !before || typeof element.animate !== "function") {
        continue;
      }
      const after = element.getBoundingClientRect();
      const deltaY = before.top - after.top;
      if (Math.abs(deltaY) < 1) {
        continue;
      }
      element.animate([{ transform: `translateY(${deltaY}px)` }, { transform: "translateY(0)" }], {
        duration: 160,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }, [displayedProjects]);

  function handleProjectDragStart(event: ReactDragEvent<HTMLElement>, projectId: string) {
    setDraggedProjectId(projectId);
    setPreviewProjectIds(projects.map((project) => project.id));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
    const dragImage = event.currentTarget.closest(".kodex-project-row");
    if (dragImage instanceof HTMLElement && typeof event.dataTransfer.setDragImage === "function") {
      event.dataTransfer.setDragImage(dragImage, 12, dragImage.offsetHeight / 2);
    }
  }

  function handleProjectDragOver(event: ReactDragEvent<HTMLElement>, targetProjectId: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const sourceProjectId = draggedProjectId ?? event.dataTransfer.getData("text/plain");
    if (!sourceProjectId || sourceProjectId === targetProjectId) {
      return;
    }
    const fallbackOrder = projects.map((project) => project.id);
    const placement = projectDragPlacement(event);
    const currentOrder = previewProjectIds ?? fallbackOrder;
    const next = moveProjectInSidebarOrderAt(currentOrder, sourceProjectId, targetProjectId, placement);
    if (sameOrder(next, currentOrder)) {
      return;
    }
    pendingProjectAnimationRects.current = projectRects(projectGroupRefs.current);
    setPreviewProjectIds(next);
  }

  function handleProjectDrop(event: ReactDragEvent<HTMLElement>, targetProjectId: string) {
    event.preventDefault();
    const sourceProjectId = draggedProjectId ?? event.dataTransfer.getData("text/plain");
    const currentProjectIds = projects.map((project) => project.id);
    const nextProjectIds =
      previewProjectIds ??
      moveProjectInSidebarOrderAt(currentProjectIds, sourceProjectId, targetProjectId, projectDragPlacement(event));
    setDraggedProjectId(null);
    setPreviewProjectIds(null);
    if (!sourceProjectId || sameOrder(nextProjectIds, currentProjectIds)) {
      return;
    }
    onReorderProjects(nextProjectIds);
  }

  function handleProjectDragEnd() {
    setDraggedProjectId(null);
    setPreviewProjectIds(null);
  }

  function handleProjectCollapseToggle(projectId: string) {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function handleHeaderCreateChat() {
    onCreateChat();
  }

  return (
    <AppShell.Navbar
      aria-label={SIDEBAR_TEXT.workspaceLabel}
      p="sm"
      className="kodex-sidebar"
      data-density={useTouchDensity ? "touch" : "compact"}
      data-mobile-scope={mobileSidebarScope}
      style={{ width: sidebarWidth }}
    >
      <Stack gap={isMobileSidebar ? "md" : "lg"} h="100%">
        <Box className="kodex-sidebar-desktop-header">
          <TextInput
            aria-label={SIDEBAR_TEXT.search}
            className="kodex-sidebar-search"
            id="kodex-sidebar-search-desktop"
            leftSection={<Search size={13} />}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder={SIDEBAR_TEXT.search}
            size="xs"
            value={searchQuery}
            variant="unstyled"
          />
          <Tooltip label={SIDEBAR_TEXT.newChat}>
            <ActionIcon
              aria-label={SIDEBAR_TEXT.startNewChatDesktop}
              className="kodex-sidebar-desktop-action"
              color="gray"
              onClick={handleHeaderCreateChat}
              size="xs"
              type="button"
              variant="subtle"
            >
              <SquarePen size={14} />
            </ActionIcon>
          </Tooltip>
        </Box>
        <Box className="kodex-sidebar-mobile-header">
          <TextInput
            aria-label={SIDEBAR_TEXT.search}
            className="kodex-sidebar-search"
            id="kodex-sidebar-search-mobile"
            leftSection={<Search size={13} />}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder={SIDEBAR_TEXT.search}
            size="xs"
            value={searchQuery}
            variant="unstyled"
          />
          <Tooltip label={SIDEBAR_TEXT.newChat}>
            <ActionIcon
              aria-label={SIDEBAR_TEXT.startNewChatMobile}
              className="kodex-sidebar-mobile-action"
              color="gray"
              onClick={handleHeaderCreateChat}
              size="md"
              type="button"
              variant="subtle"
            >
              <SquarePen size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={SIDEBAR_TEXT.showThread}>
            <ActionIcon
              aria-label={SIDEBAR_TEXT.showThread}
              className="kodex-sidebar-mobile-action"
              color="gray"
              onClick={onShowThread}
              size="md"
              type="button"
              variant="subtle"
            >
              <X size={17} />
            </ActionIcon>
          </Tooltip>
        </Box>
        <Box className="kodex-sidebar-mobile-filter">
          <button
            className="kodex-ui-button kodex-sidebar-filter-pill"
            data-active={mobileSidebarScope === "projects" ? "true" : undefined}
            onClick={() => setMobileSidebarScope("projects")}
            type="button"
          >
            {SIDEBAR_TEXT.projects}
          </button>
          <button
            className="kodex-ui-button kodex-sidebar-filter-pill"
            data-active={mobileSidebarScope === "chats" ? "true" : undefined}
            onClick={() => setMobileSidebarScope("chats")}
            type="button"
          >
            {SIDEBAR_TEXT.chats}
          </button>
        </Box>
        <Box
          className="kodex-sidebar-scroll"
          data-chats-state={dataState.chatThreads}
          data-pinned-state={dataState.pinnedThreads}
          data-projects-state={dataState.projects}
        >
          <SidebarRowFrame
            className="kodex-ui-selectable"
            leadingIcon={<Clock />}
            rootProps={{ "data-active": selectedMainPane === "automations" ? "true" : undefined }}
          >
            <button
              className="kodex-ui-button kodex-sidebar-row-main"
              onClick={onSelectAutomations}
              type="button"
            >
              <Text component="span" className="kodex-sidebar-row-label" fw={400} size="xs" lineClamp={1}>
                {SIDEBAR_TEXT.automations}
              </Text>
            </button>
          </SidebarRowFrame>
          {visiblePinnedThreads.length > 0 ? (
            <Box className="kodex-pinned-section">
              <SidebarSectionDisclosureRow
                className="kodex-pinned-section-row"
                collapsed={pinnedSectionCollapsed}
                label={SIDEBAR_TEXT.pinned}
                onToggle={() => setPinnedSectionCollapsed((collapsed) => !collapsed)}
              />
              {!pinnedSectionCollapsed ? (
                <ThreadList
                  approvals={approvals}
                  className="kodex-pinned-thread-list"
                  expanded
                  hoveredThreadActionId={hoveredThreadActionId}
                  onArchiveThread={onArchiveThread}
                  onPinThread={onPinThread}
                  onSelectThread={onSelectPinnedThread}
                  onThreadActionHoverChange={onThreadActionHoverChange}
                  onToggleExpanded={() => undefined}
                  onUnpinThread={onUnpinThread}
                  pendingTitleThreadIds={pendingTitleThreadIds}
                  selectedThreadId={selectedThreadId}
                  threads={visiblePinnedThreads}
                />
              ) : null}
            </Box>
          ) : null}
          <SidebarSectionDisclosureRow
            className="kodex-projects-section-row"
            collapsed={projectsSectionCollapsed}
            label={SIDEBAR_TEXT.projects}
            onToggle={() => setProjectsSectionCollapsed((collapsed) => !collapsed)}
            trailingActions={[
              {
                icon: <FolderPlus />,
                label: SIDEBAR_TEXT.newProject,
                onClick: () => onProjectFormOpenChange((open) => !open),
              },
            ]}
          />
          {!projectsSectionCollapsed && projectFormOpen ? (
            <Box
              component="form"
              className="kodex-project-form"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                onCreateProject();
              }}
            >
              <TextInput
                label={SIDEBAR_TEXT.cwd}
                required
                value={projectCwd}
                onChange={(event) => onProjectCwdChange(event.currentTarget.value)}
              />
              {projectDirectoryCreatePending ? (
                <Group className="kodex-project-create-confirm" gap="xs" wrap="nowrap">
                  <Button size="xs" type="button" onClick={() => onCreateProject({ createDirectory: true })}>
                    {`Create ${projectDirectoryDisplayPath(projectCwd)}?`}
                  </Button>
                  <Button
                    aria-label="Cancel directory create"
                    color="gray"
                    onClick={onProjectDirectoryCreateCancel}
                    size="xs"
                    type="button"
                    variant="light"
                  >
                    <X size={14} />
                  </Button>
                </Group>
              ) : (
                <Button type="submit" size="xs" disabled={!projectCwd.trim()}>
                  {SIDEBAR_TEXT.createProject}
                </Button>
              )}
            </Box>
          ) : null}
          {!projectsSectionCollapsed ? (
            <Stack gap="sm" className="kodex-project-tree">
              {projects.length === 0 && dataState.projects === "loaded" ? (
                <EmptyPanel icon={<Inbox size={20} />} title={SIDEBAR_TEXT.noProjectsTitle} text={SIDEBAR_TEXT.noProjectsText} />
              ) : projects.length > 0 ? (
                displayedProjects.map((project) => {
                  const projectThreads = sortThreadsForSidebar(
                    threadsByProjectId[project.id] ?? [],
                    approvals,
                    pendingTitleThreadIds,
                  );
                  const visibleProjectThreads = normalizedSearchQuery
                    ? projectThreads.filter((thread) =>
                        threadMatchesSearch(thread, normalizedSearchQuery, pendingTitleThreadIds),
                      )
                    : projectThreads;
                  const projectMatchesSearch = project.name.toLowerCase().includes(normalizedSearchQuery);
                  if (
                    normalizedSearchQuery &&
                    !projectMatchesSearch &&
                    visibleProjectThreads.length === 0
                  ) {
                    return null;
                  }
                  const projectCollapsed = collapsedProjectIds.has(project.id);
                  const showAllProjectThreads = expandedThreadProjectIds.has(project.id);
                  const newThreadLabel =
                    project.id === selectedProjectId ? SIDEBAR_TEXT.newThread : `Create thread in ${project.name}`;
                  return (
                    <Box
                      className="kodex-project-group"
                      data-threads-state={dataState.projectThreadsById[project.id] ?? "loading"}
                      key={project.id}
                      ref={(element: HTMLDivElement | null) => {
                        if (element) {
                          projectGroupRefs.current.set(project.id, element);
                        } else {
                          projectGroupRefs.current.delete(project.id);
                        }
                      }}
                      role="group"
                      aria-label={project.name}
                      onDrop={(event) => handleProjectDrop(event, project.id)}
                    >
                      <SidebarActionDisclosureRow
                        className="kodex-project-row"
                        collapsed={projectCollapsed}
                        disclosureLabel={`${projectCollapsed ? "Expand" : "Collapse"} ${project.name}`}
                        label={project.name}
                        leadingIcon={
                          projectCollapsed ? (
                            <Folder className="kodex-project-folder-icon" data-collapsed="true" />
                          ) : (
                            <FolderOpen className="kodex-project-folder-icon" />
                          )
                        }
                        mainClassName="kodex-ui-selectable kodex-project-title"
                        onToggle={() => handleProjectCollapseToggle(project.id)}
                        rootProps={{
                          draggable: true,
                          onDragEnd: handleProjectDragEnd,
                          onDragOver: (event) => handleProjectDragOver(event, project.id),
                          onDragStart: (event) => handleProjectDragStart(event, project.id),
                        }}
                        trailingActions={[
                          {
                            icon: <Settings />,
                            label: `Project settings for ${project.name}`,
                            onClick: () => onSelectProjectSettings(project.id),
                          },
                          {
                            icon: <SquarePen />,
                            label: newThreadLabel,
                            onClick: () => onCreateThread(project.id),
                          },
                        ]}
                      />
                      {!projectCollapsed && projectThreads.length > 0 ? (
                        <ThreadList
                          approvals={approvals}
                          className="kodex-project-thread-list"
                          expanded={showAllProjectThreads}
                          hoveredThreadActionId={hoveredThreadActionId}
                          onArchiveThread={onArchiveThread}
                          onPinThread={onPinThread}
                          onSelectThread={(threadId) => onSelectThread(project.id, threadId)}
                          onThreadActionHoverChange={onThreadActionHoverChange}
                          onToggleExpanded={() => {
                            setExpandedThreadProjectIds((current) => {
                              const next = new Set(current);
                              if (next.has(project.id)) {
                                next.delete(project.id);
                              } else {
                                next.add(project.id);
                              }
                              return next;
                            });
                          }}
                          onUnpinThread={onUnpinThread}
                          pendingTitleThreadIds={pendingTitleThreadIds}
                          selectedThreadId={selectedThreadId}
                          threads={projectMatchesSearch ? projectThreads : visibleProjectThreads}
                        />
                      ) : null}
                    </Box>
                  );
                })
              ) : null}
            </Stack>
          ) : null}
          <Box className="kodex-sidebar-section">
            <SidebarSectionDisclosureRow
              className="kodex-chats-section-row"
              collapsed={chatsSectionCollapsed}
              label={SIDEBAR_TEXT.chats}
              onToggle={() => setChatsSectionCollapsed((collapsed) => !collapsed)}
              trailingActions={[{ icon: <SquarePen />, label: SIDEBAR_TEXT.newChat, onClick: onCreateChat }]}
            />
            {!chatsSectionCollapsed && visibleChatThreads.length > 0 ? (
              <ThreadList
                approvals={approvals}
                className="kodex-chat-thread-list"
                expanded={chatThreadsExpanded}
                hoveredThreadActionId={hoveredThreadActionId}
                onArchiveThread={onArchiveThread}
                onPinThread={onPinThread}
                onSelectThread={onSelectChatThread}
                onThreadActionHoverChange={onThreadActionHoverChange}
                onToggleExpanded={() => setChatThreadsExpanded((expanded) => !expanded)}
                onUnpinThread={onUnpinThread}
                pendingTitleThreadIds={pendingTitleThreadIds}
                selectedThreadId={selectedThreadId}
                threads={visibleChatThreads}
              />
            ) : !chatsSectionCollapsed && dataState.chatThreads === "loaded" ? (
              <Box className="kodex-chat-empty">
                <MessageSquare size={14} />
                <Text c="dimmed" size="xs">
                  No chats
                </Text>
              </Box>
            ) : null}
          </Box>
        </Box>
        <SidebarAccountFooter
          account={account}
          loginState={loginState}
          onCancelLogin={onCancelLogin}
          onLogin={onLogin}
          onLogout={onLogout}
          onOpenPreferences={onOpenPreferences}
          onShowDebugEventsChange={onShowDebugEventsChange}
          showDebugEvents={showDebugEvents}
          usageLimitLines={usageLimitLines}
        />
      </Stack>
      <button
        aria-label={SIDEBAR_TEXT.resizeSidebarLabel}
        aria-orientation="vertical"
        aria-valuemax={520}
        aria-valuemin={292}
        aria-valuenow={sidebarWidth}
        className="kodex-sidebar-resize-handle"
        data-sidebar-resizing={isSidebarResizing ? "true" : undefined}
        onKeyDown={onSidebarResizeKeyDown}
        onPointerDown={onSidebarResizePointerDown}
        role="separator"
        type="button"
      />
    </AppShell.Navbar>
  );
});

function projectDirectoryDisplayPath(projectCwd: string): string {
  const cwd = projectCwd.trim();
  if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("/")) {
    return cwd;
  }
  return `~/${cwd}`;
}

function projectsFromPreviewOrder(projects: Project[], previewProjectIds: string[] | null): Project[] {
  if (!previewProjectIds) {
    return projects;
  }
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const orderedProjects = previewProjectIds
    .map((projectId) => projectsById.get(projectId))
    .filter((project): project is Project => Boolean(project));
  const orderedIds = new Set(orderedProjects.map((project) => project.id));
  return [...orderedProjects, ...projects.filter((project) => !orderedIds.has(project.id))];
}

function projectRects(projectRefs: Map<string, HTMLElement>): Map<string, DOMRect> {
  return new Map(Array.from(projectRefs, ([projectId, element]) => [projectId, element.getBoundingClientRect()]));
}

function projectDragPlacement(event: ReactDragEvent<HTMLElement>): "before" | "after" {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
}

function sameOrder(left: string[] | null, right: string[]): boolean {
  return left !== null && left.length === right.length && left.every((value, index) => value === right[index]);
}

function threadMatchesSearch(thread: ThreadSummary, query: string, pendingTitleThreadIds: Set<string>): boolean {
  return threadDisplayTitleWithPending(thread, pendingTitleThreadIds).toLowerCase().includes(query);
}

function threadDisplayTitleWithPending(thread: ThreadSummary, pendingTitleThreadIds: Set<string>): string {
  return pendingTitleThreadIds.has(thread.id) ? SIDEBAR_TEXT.newThread : threadDisplayTitle(thread);
}

export type ThreadListRowProps = {
  approvals: Approval[];
  isSelected: boolean;
  onArchiveThread: (threadId: string) => void;
  onPinThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  showThreadArchiveAction: boolean;
  thread: ThreadSummary;
};

export const ThreadListRow = memo(function ThreadListRow({
  approvals,
  isSelected,
  onArchiveThread,
  onPinThread,
  onSelectThread,
  onThreadActionHoverChange,
  onUnpinThread,
  pendingTitleThreadIds,
  showThreadArchiveAction,
  thread,
}: ThreadListRowProps) {
  const needsApproval = threadNeedsApproval(thread, approvals);
  const isThreadInProgress = threadInProgress(thread);
  const hasUnreadAgentTurn = thread.unreadCompletedAgentTurn === true;
  const displayTitle = threadDisplayTitleWithPending(thread, pendingTitleThreadIds);
  const pinnedAt = thread.pinnedAt ?? null;
  const isPinned = Boolean(pinnedAt);
  const pinLabel = isPinned ? SIDEBAR_TEXT.unpinThread : SIDEBAR_TEXT.pinThread;

  return (
    <SidebarRowFrame
      className="kodex-ui-selectable kodex-list-button kodex-thread-list-button"
      leadingContent={
        <Tooltip label={pinLabel}>
          <button
            aria-label={pinLabel}
            className="kodex-ui-button kodex-ui-icon-button kodex-thread-pin-button"
            onClick={(event) => {
              event.stopPropagation();
              if (isPinned) {
                onUnpinThread(thread.id);
              } else {
                onPinThread(thread.id);
              }
            }}
            type="button"
          >
            {isPinned ? <PinOff /> : <Pin />}
          </button>
        </Tooltip>
      }
      rootProps={{
        "data-active": isSelected ? "true" : undefined,
        "data-pinned": isPinned ? "true" : undefined,
        onBlur: (event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            onThreadActionHoverChange(null);
          }
        },
        onFocus: () => onThreadActionHoverChange(thread.id),
        onMouseEnter: () => onThreadActionHoverChange(thread.id),
        onMouseLeave: () => onThreadActionHoverChange(null),
      }}
      trailingContent={
        <>
          {isThreadInProgress && !showThreadArchiveAction ? (
            <Tooltip label={SIDEBAR_TEXT.threadInProgress}>
              <Box
                aria-label={SIDEBAR_TEXT.threadInProgress}
                className="kodex-thread-status-slot"
                component="span"
                role="status"
              >
                <span className="kodex-thread-progress-indicator" />
              </Box>
            </Tooltip>
          ) : null}
          {hasUnreadAgentTurn && !isThreadInProgress && !showThreadArchiveAction ? (
            <Tooltip label={SIDEBAR_TEXT.unreadAgentTurn}>
              <Box
                aria-label={SIDEBAR_TEXT.unreadAgentTurn}
                className="kodex-thread-status-slot"
                component="span"
                role="img"
              >
                <span className="kodex-thread-unread-agent-turn-indicator" />
              </Box>
            </Tooltip>
          ) : null}
          {showThreadArchiveAction ? (
            <Tooltip label="Archive thread">
              <button
                aria-label={`Archive ${displayTitle}`}
                className="kodex-ui-button kodex-ui-icon-button kodex-thread-archive-button"
                onClick={() => onArchiveThread(thread.id)}
                type="button"
              >
                <Archive />
              </button>
            </Tooltip>
          ) : null}
        </>
      }
    >
      <button className="kodex-ui-button kodex-thread-select-button" onClick={() => onSelectThread(thread.id)} type="button">
        <Group
          align="flex-start"
          className="kodex-thread-list-row"
          data-has-sidecar={needsApproval ? "true" : undefined}
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
            {displayTitle}
          </Text>
          {needsApproval ? (
            <Badge className="kodex-thread-approval-badge" data-tone="warning" size="xs" variant="light">
              Needs approval
            </Badge>
          ) : null}
        </Group>
      </button>
    </SidebarRowFrame>
  );
}, areThreadListRowPropsEqual);

export function areThreadListRowPropsEqual(previous: ThreadListRowProps, next: ThreadListRowProps) {
  return (
    previous.approvals === next.approvals &&
    previous.isSelected === next.isSelected &&
    previous.onArchiveThread === next.onArchiveThread &&
    previous.onPinThread === next.onPinThread &&
    previous.onSelectThread === next.onSelectThread &&
    previous.onThreadActionHoverChange === next.onThreadActionHoverChange &&
    previous.onUnpinThread === next.onUnpinThread &&
    previous.pendingTitleThreadIds === next.pendingTitleThreadIds &&
    previous.showThreadArchiveAction === next.showThreadArchiveAction &&
    previous.thread === next.thread
  );
}

function ThreadList({
  approvals,
  className,
  expanded,
  hoveredThreadActionId,
  onArchiveThread,
  onPinThread,
  onSelectThread,
  onThreadActionHoverChange,
  onToggleExpanded,
  onUnpinThread,
  pendingTitleThreadIds,
  selectedThreadId,
  threads,
}: {
  approvals: Approval[];
  className: string;
  expanded: boolean;
  hoveredThreadActionId: string | null;
  onArchiveThread: (threadId: string) => void;
  onPinThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onToggleExpanded: () => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  selectedThreadId: string | null;
  threads: ThreadSummary[];
}) {
  const visibleThreads = expanded ? threads : threads.slice(0, VISIBLE_THREAD_LIMIT);
  const hasHiddenThreads = threads.length > VISIBLE_THREAD_LIMIT;

  return (
    <Stack className={className} gap={6}>
      {visibleThreads.map((thread) => (
        <ThreadListRow
          approvals={approvals}
          isSelected={thread.id === selectedThreadId}
          key={thread.id}
          onArchiveThread={onArchiveThread}
          onPinThread={onPinThread}
          onSelectThread={onSelectThread}
          onThreadActionHoverChange={onThreadActionHoverChange}
          onUnpinThread={onUnpinThread}
          pendingTitleThreadIds={pendingTitleThreadIds}
          showThreadArchiveAction={hoveredThreadActionId === thread.id}
          thread={thread}
        />
      ))}
      {hasHiddenThreads ? (
        <button className="kodex-ui-button kodex-thread-list-more-button" onClick={onToggleExpanded} type="button">
          {expanded ? SIDEBAR_TEXT.showLessThreads : SIDEBAR_TEXT.showMoreThreads}
        </button>
      ) : null}
    </Stack>
  );
}
