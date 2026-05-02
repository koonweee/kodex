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
import { Archive, FolderClosed, FolderOpen, GitBranch, GripVertical, Inbox, SquarePen } from "lucide-react";
import {
  memo,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { AccountResponse, Approval, Project, ThreadSummary } from "../api/client";
import { SidebarAccountFooter, type LoginState } from "../account/SidebarAccountFooter";
import { EmptyPanel } from "../ui/EmptyPanel";
import {
  threadDisplayTitle,
  threadInProgress,
  threadNeedsApproval,
  sortThreadsForSidebar,
  type ThreadsByProjectId,
} from "./helpers";
import { moveProjectInSidebarOrder } from "./projectOrder";

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
  reorderProject: "Drag to reorder project",
  resizeSidebarLabel: "Resize workspace sidebar",
  threadInProgress: "Thread in progress",
  unreadAgentTurn: "Unread completed agent turn",
  workspaceLabel: "Workspace",
};

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
  onSelectProject,
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
  onSelectProject: (projectId: string) => void;
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
}) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);

  function handleProjectDragStart(event: ReactDragEvent<HTMLElement>, projectId: string) {
    setDraggedProjectId(projectId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
  }

  function handleProjectDragOver(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleProjectDrop(event: ReactDragEvent<HTMLElement>, targetProjectId: string) {
    event.preventDefault();
    const sourceProjectId = draggedProjectId ?? event.dataTransfer.getData("text/plain");
    setDraggedProjectId(null);
    if (!sourceProjectId || sourceProjectId === targetProjectId) {
      return;
    }
    onReorderProjects(moveProjectInSidebarOrder(projects.map((project) => project.id), sourceProjectId, targetProjectId));
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
              projects.map((project) => {
                const projectThreads = sortThreadsForSidebar(
                  threadsByProjectId[project.id] ?? [],
                  approvals,
                  pendingTitleThreadIds,
                );
                const projectCollapsed = collapsedProjectIds.has(project.id);
                const FolderIcon = projectCollapsed ? FolderClosed : FolderOpen;
                const newThreadLabel =
                  project.id === selectedProjectId ? SIDEBAR_TEXT.newThread : `Create thread in ${project.name}`;
                return (
                  <Box
                    className="kodex-project-group"
                    key={project.id}
                    role="group"
                    aria-label={project.name}
                    onDragOver={handleProjectDragOver}
                    onDrop={(event) => handleProjectDrop(event, project.id)}
                  >
                    <Box className="kodex-project-row">
                      <Tooltip label={SIDEBAR_TEXT.reorderProject}>
                        <ActionIcon
                          aria-label={`${SIDEBAR_TEXT.reorderProject}: ${project.name}`}
                          className="kodex-project-drag-handle"
                          color="gray"
                          draggable
                          onDragEnd={() => setDraggedProjectId(null)}
                          onDragStart={(event) => handleProjectDragStart(event, project.id)}
                          size="sm"
                          variant="subtle"
                        >
                          <GripVertical size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <button
                        aria-expanded={!projectCollapsed}
                        aria-label={`${project.name} ${project.cwd}`}
                        className="kodex-project-select-button"
                        data-active={project.id === selectedProjectId}
                        onClick={() => {
                          setCollapsedProjectIds((current) => {
                            const next = new Set(current);
                            if (project.id === selectedProjectId) {
                              if (next.has(project.id)) {
                                next.delete(project.id);
                              } else {
                                next.add(project.id);
                              }
                            } else {
                              next.delete(project.id);
                            }
                            return next;
                          });
                          onSelectProject(project.id);
                        }}
                        type="button"
                      >
                        <FolderIcon size={15} />
                        <Text fw={500} size="xs" lineClamp={1}>
                          {project.name}
                        </Text>
                      </button>
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
                    {!projectCollapsed && projectThreads.length > 0 ? (
                      <Stack className="kodex-project-thread-list" gap={6}>
                        {projectThreads.map((thread) => (
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
