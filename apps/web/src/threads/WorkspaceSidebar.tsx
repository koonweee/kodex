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
import { Archive, FolderOpen, GitBranch, Inbox, SquarePen } from "lucide-react";
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
  sortThreadsForSidebar,
  type ThreadsByProjectId,
} from "./helpers";
import { moveProjectInSidebarOrderAt } from "./projectOrder";

const SIDEBAR_TEXT = {
  cancelLogin: "Cancel login",
  createProject: "Create project",
  cwd: "Working directory",
  name: "Project name",
  newProject: "New project",
  newThread: "New thread",
  noProjectsText: "Create a project to begin.",
  noProjectsTitle: "No projects",
  projects: "Projects",
  resizeSidebarLabel: "Resize workspace sidebar",
  showLessThreads: "Show less",
  showMoreThreads: "Show more",
  threadInProgress: "Thread in progress",
  unreadAgentTurn: "Unread completed agent turn",
  workspaceLabel: "Workspace",
};

const VISIBLE_THREAD_LIMIT = 5;

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  account,
  approvals,
  hoveredThreadActionId,
  isSidebarResizing,
  loginState,
  onArchiveThread,
  onCancelLogin,
  onCreateProject,
  onCreateThread,
  onLogin,
  onLogout,
  onOpenPreferences,
  onProjectCwdChange,
  onProjectFormOpenChange,
  onProjectNameChange,
  onReorderProjects,
  onSelectThread,
  onShowDebugEventsChange,
  onSidebarResizeKeyDown,
  onSidebarResizePointerDown,
  onThreadActionHoverChange,
  pendingTitleThreadIds,
  projectCwd,
  projectFormOpen,
  projectName,
  projects,
  selectedProjectId,
  selectedThreadId,
  showDebugEvents,
  sidebarWidth,
  threadsByProjectId,
  usageLimitLines,
}: {
  account: AccountResponse | null;
  approvals: Approval[];
  hoveredThreadActionId: string | null;
  isSidebarResizing: boolean;
  loginState: LoginState;
  onArchiveThread: (threadId: string) => void;
  onCancelLogin: () => void;
  onCreateProject: (event: FormEvent) => void;
  onCreateThread: (projectId: string) => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenPreferences: () => void;
  onProjectCwdChange: (value: string) => void;
  onProjectFormOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  onProjectNameChange: (value: string) => void;
  onReorderProjects: (projectIds: string[]) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onShowDebugEventsChange: (value: boolean) => void;
  onSidebarResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSidebarResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  pendingTitleThreadIds: Set<string>;
  projectCwd: string;
  projectFormOpen: boolean;
  projectName: string;
  projects: Project[];
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  showDebugEvents: boolean;
  sidebarWidth: number;
  threadsByProjectId: ThreadsByProjectId;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [expandedThreadProjectIds, setExpandedThreadProjectIds] = useState<Set<string>>(() => new Set());
  const [previewProjectIds, setPreviewProjectIds] = useState<string[] | null>(null);
  const projectGroupRefs = useRef<Map<string, HTMLElement>>(new Map());
  const pendingProjectAnimationRects = useRef<Map<string, DOMRect> | null>(null);
  const displayedProjects = useMemo(
    () => projectsFromPreviewOrder(projects, previewProjectIds),
    [previewProjectIds, projects],
  );

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

  return (
    <AppShell.Navbar
      aria-label={SIDEBAR_TEXT.workspaceLabel}
      p="sm"
      className="kodex-sidebar"
      style={{ width: sidebarWidth }}
    >
      <Stack gap="lg" h="100%">
        <Box className="kodex-sidebar-scroll">
          <Group justify="space-between" align="center" mb="sm">
            <Text className="kodex-project-section-title" fw={700} size="sm">
              {SIDEBAR_TEXT.projects}
            </Text>
            <Tooltip label={SIDEBAR_TEXT.newProject}>
              <ActionIcon
                variant="subtle"
                aria-label={SIDEBAR_TEXT.newProject}
                color="gray"
                onClick={() => onProjectFormOpenChange((open) => !open)}
                size="sm"
              >
                <GitBranch size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
          {projectFormOpen ? (
            <Box component="form" className="kodex-project-form" onSubmit={onCreateProject}>
              <TextInput
                label={SIDEBAR_TEXT.name}
                value={projectName}
                onChange={(event) => onProjectNameChange(event.currentTarget.value)}
              />
              <TextInput
                label={SIDEBAR_TEXT.cwd}
                required
                value={projectCwd}
                onChange={(event) => onProjectCwdChange(event.currentTarget.value)}
              />
              <Button type="submit" size="xs" disabled={!projectCwd.trim()}>
                {SIDEBAR_TEXT.createProject}
              </Button>
            </Box>
          ) : null}
          <Stack gap="sm" className="kodex-project-tree">
            {projects.length === 0 ? (
              <EmptyPanel icon={<Inbox size={20} />} title={SIDEBAR_TEXT.noProjectsTitle} text={SIDEBAR_TEXT.noProjectsText} />
            ) : (
              displayedProjects.map((project) => {
                const projectThreads = sortThreadsForSidebar(
                  threadsByProjectId[project.id] ?? [],
                  approvals,
                  pendingTitleThreadIds,
                );
                const showAllProjectThreads = expandedThreadProjectIds.has(project.id);
                const visibleProjectThreads = showAllProjectThreads
                  ? projectThreads
                  : projectThreads.slice(0, VISIBLE_THREAD_LIMIT);
                const hasHiddenProjectThreads = projectThreads.length > VISIBLE_THREAD_LIMIT;
                const newThreadLabel =
                  project.id === selectedProjectId ? SIDEBAR_TEXT.newThread : `Create thread in ${project.name}`;
                return (
                  <Box
                    className="kodex-project-group"
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
                    <Box
                      className="kodex-project-row"
                      draggable
                      onDragEnd={handleProjectDragEnd}
                      onDragOver={(event) => handleProjectDragOver(event, project.id)}
                      onDragStart={(event) => handleProjectDragStart(event, project.id)}
                    >
                      <Box
                        aria-label={`${project.name} ${project.cwd}`}
                        className="kodex-project-title"
                        data-active={project.id === selectedProjectId}
                      >
                        <FolderOpen size={15} />
                        <Text fw={500} size="xs" lineClamp={1}>
                          {project.name}
                        </Text>
                      </Box>
                      <Tooltip label={SIDEBAR_TEXT.newThread}>
                        <ActionIcon
                          aria-label={newThreadLabel}
                          color="gray"
                          onClick={() => onCreateThread(project.id)}
                          size="sm"
                          variant="subtle"
                        >
                          <SquarePen size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Box>
                    {projectThreads.length > 0 ? (
                      <Stack className="kodex-project-thread-list" gap={6}>
                        {visibleProjectThreads.map((thread) => (
                          <ThreadListRow
                            approvals={approvals}
                            isSelected={thread.id === selectedThreadId}
                            key={thread.id}
                            onArchiveThread={onArchiveThread}
                            onSelectThread={onSelectThread}
                            onThreadActionHoverChange={onThreadActionHoverChange}
                            pendingTitleThreadIds={pendingTitleThreadIds}
                            projectId={project.id}
                            showThreadArchiveAction={hoveredThreadActionId === thread.id}
                            thread={thread}
                          />
                        ))}
                        {hasHiddenProjectThreads ? (
                          <button
                            className="kodex-thread-list-more-button"
                            onClick={() => {
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
                            type="button"
                          >
                            {showAllProjectThreads ? SIDEBAR_TEXT.showLessThreads : SIDEBAR_TEXT.showMoreThreads}
                          </button>
                        ) : null}
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

export type ThreadListRowProps = {
  approvals: Approval[];
  isSelected: boolean;
  onArchiveThread: (threadId: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  pendingTitleThreadIds: Set<string>;
  projectId: string;
  showThreadArchiveAction: boolean;
  thread: ThreadSummary;
};

export const ThreadListRow = memo(function ThreadListRow({
  approvals,
  isSelected,
  onArchiveThread,
  onSelectThread,
  onThreadActionHoverChange,
  pendingTitleThreadIds,
  projectId,
  showThreadArchiveAction,
  thread,
}: ThreadListRowProps) {
  const needsApproval = threadNeedsApproval(thread, approvals);
  const isThreadInProgress = threadInProgress(thread);
  const hasUnreadAgentTurn = thread.unreadCompletedAgentTurn === true;
  const displayTitle = pendingTitleThreadIds.has(thread.id) ? SIDEBAR_TEXT.newThread : threadDisplayTitle(thread);

  return (
    <Box
      className="kodex-list-button kodex-thread-list-button"
      data-active={isSelected}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onThreadActionHoverChange(null);
        }
      }}
      onFocus={() => onThreadActionHoverChange(thread.id)}
      onMouseEnter={() => onThreadActionHoverChange(thread.id)}
      onMouseLeave={() => onThreadActionHoverChange(null)}
    >
      <button className="kodex-thread-select-button" onClick={() => onSelectThread(projectId, thread.id)} type="button">
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
            <Badge className="kodex-thread-approval-badge" color="orange" size="xs" variant="light">
              Needs approval
            </Badge>
          ) : null}
        </Group>
      </button>
      <Box className="kodex-thread-list-action-slot">
        {isThreadInProgress && !showThreadArchiveAction ? (
          <Tooltip label={SIDEBAR_TEXT.threadInProgress}>
            <Box
              aria-label={SIDEBAR_TEXT.threadInProgress}
              className="kodex-thread-progress-indicator"
              component="span"
              role="status"
            />
          </Tooltip>
        ) : null}
        {hasUnreadAgentTurn && !isThreadInProgress && !showThreadArchiveAction ? (
          <Tooltip label={SIDEBAR_TEXT.unreadAgentTurn}>
            <Box
              aria-label={SIDEBAR_TEXT.unreadAgentTurn}
              className="kodex-thread-unread-agent-turn-indicator"
              component="span"
              role="img"
            />
          </Tooltip>
        ) : null}
        {showThreadArchiveAction ? (
          <Tooltip label="Archive thread">
            <button
              aria-label={`Archive ${displayTitle}`}
              className="kodex-thread-archive-button"
              onClick={() => onArchiveThread(thread.id)}
              type="button"
            >
              <Archive size={13} />
            </button>
          </Tooltip>
        ) : null}
      </Box>
    </Box>
  );
}, areThreadListRowPropsEqual);

export function areThreadListRowPropsEqual(previous: ThreadListRowProps, next: ThreadListRowProps) {
  return (
    previous.approvals === next.approvals &&
    previous.isSelected === next.isSelected &&
    previous.onArchiveThread === next.onArchiveThread &&
    previous.onSelectThread === next.onSelectThread &&
    previous.onThreadActionHoverChange === next.onThreadActionHoverChange &&
    previous.pendingTitleThreadIds === next.pendingTitleThreadIds &&
    previous.projectId === next.projectId &&
    previous.showThreadArchiveAction === next.showThreadArchiveAction &&
    previous.thread === next.thread
  );
}
