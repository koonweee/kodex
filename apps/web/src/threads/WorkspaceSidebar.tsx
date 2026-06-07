import {
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  Archive,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import type { AccountResponse, Approval, Project, ThreadSummary } from "../api/client";
import type { UsageLimitLines } from "../account/rateLimits";
import { SidebarAccountMenu } from "../account/SidebarAccountFooter";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { NARROW_WORKSPACE_QUERY } from "../shared/layoutBreakpoints";
import { AdaptiveIcon } from "../ui/AdaptiveIcon";
import { EmptyPanel } from "../ui/EmptyPanel";
import {
  threadDisplayTitle,
  threadInProgress,
  threadNeedsApproval,
  sortPinnedThreadsForSidebar,
  sortProjectThreadsForSidebar,
  sortThreadsForSidebar,
  type ThreadsByProjectId,
} from "./helpers";
import { moveProjectInSidebarOrderAt } from "./projectOrder";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  loadSidebarDisclosureState,
  saveSidebarDisclosureState,
  type SidebarDisclosureState,
} from "./sidebarDisclosureState";
import {
  SidebarActionDisclosureRow,
  SidebarRowFrame,
  SidebarSectionDisclosureRow,
  SidebarTextActionRow,
  SidebarTextInputRow,
} from "./sidebarRows";

const SIDEBAR_TEXT = {
  chats: "Chats",
  collapseSidebar: "Collapse workspace sidebar",
  createProject: "Add project",
  cwd: "Directory",
  expandSidebarHandle: "Expand workspace sidebar",
  newChat: "New chat",
  newProject: "Add project",
  newThread: "New thread",
  noProjectsText: "Create a project to begin.",
  noProjectsTitle: "No projects",
  openTerminal: "Open terminal",
  pinned: "Pinned",
  pinThread: "Pin thread",
  projects: "Projects",
  resizeSidebarLabel: "Resize workspace sidebar",
  recentThreads: "Recent threads",
  recents: "Recents",
  search: "Search",
  showThread: "Show thread",
  showLessThreads: "Show less",
  showMoreError: "Could not load more threads",
  showMoreLoading: "Loading more",
  showMoreThreads: "Show more",
  threadInProgress: "Thread in progress",
  unreadAgentTurn: "Unread completed agent turn",
  unpinThread: "Unpin thread",
  workspaceLabel: "Workspace",
};

const VISIBLE_THREAD_LIMIT = 5;
type SidebarScope = "projects" | "chats";
type SidebarDataLoadState = "error" | "loaded" | "loading" | "refetching";
type SidebarPaginationState = "idle" | "loading" | "error";

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
  chatThreadsHasMore = false,
  chatThreadsPaginationState = "idle",
  dataState = DEFAULT_DATA_STATE,
  hoveredThreadActionId,
  onArchiveThread,
  onCreateChat,
  onCreateProject,
  onCreateThread,
  onLogout,
  onLoadMoreChatThreads,
  onLoadMoreProjectThreads,
  onOpenPreferences,
  onOpenTerminal,
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
  onSidebarCollapseClick,
  onSidebarExpandClick,
  onThreadActionHoverChange,
  onUnpinThread,
  pinnedThreads,
  pendingTitleThreadIds,
  projectCwd,
  projectDirectoryCreatePending,
  projectFormOpen,
  projectThreadHasMoreById = {},
  projectThreadPaginationStateById = {},
  projects,
  selectedProjectId,
  selectedMainPane,
  selectedThreadId,
  showDebugEvents,
  sidebarCollapsed = false,
  sidebarWidth,
  threadsByProjectId,
  usageLimitLines,
}: {
  account: AccountResponse | null;
  approvals: Approval[];
  chatThreads: ThreadSummary[];
  chatThreadsHasMore?: boolean;
  chatThreadsPaginationState?: SidebarPaginationState;
  dataState?: WorkspaceSidebarDataState;
  hoveredThreadActionId: string | null;
  onArchiveThread: (threadId: string) => void;
  onCreateChat: () => void;
  onCreateProject: (options?: { createDirectory?: boolean }) => void;
  onCreateThread: (projectId: string) => void;
  onLogout: () => void;
  onLoadMoreChatThreads?: () => void;
  onLoadMoreProjectThreads?: (projectId: string) => void;
  onOpenPreferences: () => void;
  onOpenTerminal?: () => void;
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
  onSidebarCollapseClick: () => void;
  onSidebarExpandClick: () => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  pinnedThreads: ThreadSummary[];
  projectCwd: string;
  projectDirectoryCreatePending: boolean;
  projectFormOpen: boolean;
  projectThreadHasMoreById?: Record<string, boolean>;
  projectThreadPaginationStateById?: Record<string, SidebarPaginationState>;
  projects: Project[];
  selectedProjectId: string | null;
  selectedMainPane: "thread" | "automations" | "project";
  selectedThreadId: string | null;
  showDebugEvents: boolean;
  sidebarCollapsed?: boolean;
  sidebarWidth: number;
  threadsByProjectId: ThreadsByProjectId;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [sidebarDisclosureState, setSidebarDisclosureState] = useState<SidebarDisclosureState>(() =>
    loadSidebarDisclosureState(),
  );
  const [chatThreadsExpanded, setChatThreadsExpanded] = useState(false);
  const [expandedThreadProjectIds, setExpandedThreadProjectIds] = useState<Set<string>>(() => new Set());
  const [sidebarScope, setSidebarScope] = useState<SidebarScope>("projects");
  const [previewProjectIds, setPreviewProjectIds] = useState<string[] | null>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarScrollState, setSidebarScrollState] = useState({ bottom: false, stickyProjectHeader: false, top: false });
  const isNarrowSidebar = useMediaQuery(NARROW_WORKSPACE_QUERY, false);
  const useTouchDensity = useInputCapabilities().hasTouchInput;
  const projectGroupRefs = useRef<Map<string, HTMLElement>>(new Map());
  const pendingProjectAnimationRects = useRef<Map<string, DOMRect> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
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
  const projectScopeLookup = useMemo(() => sidebarProjectScopeLookup(projects), [projects]);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const scopedPinnedThreads =
    sidebarScope === "chats" ? sortedPinnedThreads.filter((thread) => !pinnedThreadBelongsToProject(thread, projectScopeLookup)) : [];
  const visiblePinnedThreads = normalizedSearchQuery
    ? scopedPinnedThreads.filter((thread) => threadMatchesSearch(thread, normalizedSearchQuery, pendingTitleThreadIds))
    : scopedPinnedThreads;
  const visibleChatThreads = normalizedSearchQuery
    ? sortedChatThreads.filter((thread) => threadMatchesSearch(thread, normalizedSearchQuery, pendingTitleThreadIds))
    : sortedChatThreads;
  const {
    chatsSectionCollapsed,
    collapsedProjectIds,
    pinnedSectionCollapsed,
    projectsSectionCollapsed,
  } = sidebarDisclosureState;
  const recentThreads = useMemo(
    () =>
      recentSidebarThreads({
        chatThreads,
        pinnedThreads,
        projects,
        threadsByProjectId,
      }),
    [chatThreads, pinnedThreads, projects, threadsByProjectId],
  );

  useEffect(() => {
    if (!searchActive || sidebarCollapsed) {
      return;
    }
    searchInputRef.current?.focus();
  }, [searchActive, sidebarCollapsed]);

  const updateSidebarScrollEdges = useCallback(() => {
    const element = sidebarScrollRef.current;
    if (!element) {
      setSidebarScrollState({ bottom: false, stickyProjectHeader: false, top: false });
      return;
    }
    const scrollFrameTop = element.parentElement?.getBoundingClientRect().top ?? element.getBoundingClientRect().top;
    const stickyProjectHeader = Array.from(element.querySelectorAll<HTMLElement>(".kodex-project-row")).some((row) => {
      const rowRect = row.getBoundingClientRect();
      return rowRect.top <= scrollFrameTop + 1 && rowRect.bottom > scrollFrameTop + 1;
    });
    const next = {
      bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
      stickyProjectHeader,
      top: element.scrollTop > 1,
    };
    setSidebarScrollState((current) =>
      current.bottom === next.bottom && current.stickyProjectHeader === next.stickyProjectHeader && current.top === next.top
        ? current
        : next,
    );
  }, []);

  useEffect(() => {
    const element = sidebarScrollRef.current;
    if (!element || sidebarCollapsed) {
      setSidebarScrollState({ bottom: false, stickyProjectHeader: false, top: false });
      return;
    }
    element.addEventListener("scroll", updateSidebarScrollEdges, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(updateSidebarScrollEdges) : null;
    resizeObserver?.observe(element);
    updateSidebarScrollEdges();
    return () => {
      element.removeEventListener("scroll", updateSidebarScrollEdges);
      resizeObserver?.disconnect();
    };
  }, [sidebarCollapsed, updateSidebarScrollEdges]);

  useLayoutEffect(() => {
    updateSidebarScrollEdges();
  });

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
    updateSidebarDisclosureState((current) => {
      const nextCollapsedProjectIds = new Set(current.collapsedProjectIds);
      if (nextCollapsedProjectIds.has(projectId)) {
        nextCollapsedProjectIds.delete(projectId);
      } else {
        nextCollapsedProjectIds.add(projectId);
      }
      return {
        ...current,
        collapsedProjectIds: nextCollapsedProjectIds,
      };
    });
  }

  function handleSectionCollapseToggle(
    section: "chatsSectionCollapsed" | "pinnedSectionCollapsed" | "projectsSectionCollapsed",
  ) {
    updateSidebarDisclosureState((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  function updateSidebarDisclosureState(updater: (current: SidebarDisclosureState) => SidebarDisclosureState) {
    setSidebarDisclosureState((current) => {
      const next = updater(current);
      saveSidebarDisclosureState(next);
      return next;
    });
  }

  function handleSearchActivate() {
    setSearchActive(true);
  }

  function handleSearchBlur() {
    if (!searchQuery.trim()) {
      setSearchActive(false);
    }
  }

  function handleCollapsedSearchClick() {
    onSidebarExpandClick();
    setSearchActive(true);
  }

  function handleRecentThreadSelect(thread: RecentSidebarThread) {
    if (thread.location.kind === "project") {
      onSelectThread(thread.location.projectId, thread.thread.id);
    } else if (thread.location.kind === "chat") {
      onSelectChatThread(thread.thread.id);
    } else {
      onSelectPinnedThread(thread.thread.id);
    }
  }

  return (
    <AppShell.Navbar
      aria-label={SIDEBAR_TEXT.workspaceLabel}
      p="sm"
      className="kodex-sidebar"
      data-density={useTouchDensity ? "touch" : "compact"}
      data-main-pane={selectedMainPane}
      data-collapsed={sidebarCollapsed ? "true" : undefined}
      data-sidebar-scope={sidebarScope}
      style={{ width: sidebarWidth }}
    >
      <Stack gap={isNarrowSidebar ? 8 : "lg"} h="100%">
        {!sidebarCollapsed ? (
          <>
            <Box className="kodex-sidebar-header">
              <SidebarAccountMenu
                account={account}
                onLogout={onLogout}
                onSelectAutomations={onSelectAutomations}
                onOpenPreferences={onOpenPreferences}
                onShowDebugEventsChange={onShowDebugEventsChange}
                showDebugEvents={showDebugEvents}
                usageLimitLines={usageLimitLines}
              />
              <SidebarIconButton
                className="kodex-sidebar-header-action"
                label={isNarrowSidebar ? SIDEBAR_TEXT.showThread : SIDEBAR_TEXT.collapseSidebar}
                onClick={isNarrowSidebar ? onShowThread : onSidebarCollapseClick}
                tooltipProps={{ position: isNarrowSidebar ? "bottom" : "right" }}
              >
                <PanelLeftClose size={16} />
              </SidebarIconButton>
            </Box>
            <Box className="kodex-sidebar-actions" aria-label="Sidebar actions">
              <SearchActionRow
                active={searchActive}
                inputRef={searchInputRef}
                onActivate={handleSearchActivate}
                onBlur={handleSearchBlur}
                onChange={setSearchQuery}
                query={searchQuery}
              />
              {onOpenTerminal ? <SidebarTextActionRow icon={<SquareTerminal />} label="Terminal" onClick={onOpenTerminal} /> : null}
            </Box>
            <Box className="kodex-sidebar-scope-switch">
              <button
                aria-pressed={sidebarScope === "projects"}
                className="kodex-ui-button kodex-sidebar-filter-pill"
                data-active={sidebarScope === "projects" ? "true" : undefined}
                onClick={() => setSidebarScope("projects")}
                type="button"
              >
                {SIDEBAR_TEXT.projects}
              </button>
              <button
                aria-pressed={sidebarScope === "chats"}
                className="kodex-ui-button kodex-sidebar-filter-pill"
                data-active={sidebarScope === "chats" ? "true" : undefined}
                onClick={() => setSidebarScope("chats")}
                type="button"
              >
                {SIDEBAR_TEXT.chats}
              </button>
            </Box>
            <Box
              className="kodex-sidebar-scroll-frame"
              data-can-scroll-bottom={sidebarScrollState.bottom ? "true" : undefined}
              data-can-scroll-top={sidebarScrollState.top ? "true" : undefined}
              data-sticky-project-header={sidebarScrollState.stickyProjectHeader ? "true" : undefined}
            >
              <Box
                className="kodex-sidebar-scroll"
                data-chats-state={dataState.chatThreads}
                data-pinned-state={dataState.pinnedThreads}
                data-projects-state={dataState.projects}
                ref={sidebarScrollRef}
              >
                {visiblePinnedThreads.length > 0 ? (
                  <Box className="kodex-pinned-section">
                    <SidebarSectionDisclosureRow
                      className="kodex-pinned-section-row"
                      collapsed={pinnedSectionCollapsed}
                      label={SIDEBAR_TEXT.pinned}
                      onToggle={() => handleSectionCollapseToggle("pinnedSectionCollapsed")}
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
                {sidebarScope === "projects" ? (
                  <>
                    <SidebarSectionDisclosureRow
                      className="kodex-projects-section-row"
                      collapsed={projectsSectionCollapsed}
                      label={SIDEBAR_TEXT.projects}
                      onToggle={() => handleSectionCollapseToggle("projectsSectionCollapsed")}
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
                          <EmptyPanel
                            icon={<Inbox size={20} />}
                            title={SIDEBAR_TEXT.noProjectsTitle}
                            text={SIDEBAR_TEXT.noProjectsText}
                          />
                        ) : projects.length > 0 ? (
                          displayedProjects.map((project) => {
                            const projectThreads = sortProjectThreadsForSidebar(
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
                            if (normalizedSearchQuery && !projectMatchesSearch && visibleProjectThreads.length === 0) {
                              return null;
                            }
                            const projectCollapsed = collapsedProjectIds.has(project.id);
                            const showAllProjectThreads = expandedThreadProjectIds.has(project.id);
                            const projectThreadsHaveMore = projectThreadHasMoreById[project.id] === true;
                            const projectThreadPaginationState = projectThreadPaginationStateById[project.id] ?? "idle";
                            const displayedProjectThreads = projectMatchesSearch ? projectThreads : visibleProjectThreads;
                            const collapsedProjectThreads = displayedProjectThreads.filter((thread) =>
                              threadSurfacesWhenProjectCollapsed(thread, selectedThreadId),
                            );
                            const renderedProjectThreads = projectCollapsed ? collapsedProjectThreads : displayedProjectThreads;
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
                                      <AdaptiveIcon className="kodex-project-folder-icon" data-collapsed="true">
                                        <Folder />
                                      </AdaptiveIcon>
                                    ) : (
                                      <AdaptiveIcon className="kodex-project-folder-icon">
                                        <FolderOpen />
                                      </AdaptiveIcon>
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
                                {renderedProjectThreads.length > 0 ? (
                                  <ThreadList
                                    approvals={approvals}
                                    className="kodex-project-thread-list"
                                    expanded={projectCollapsed || showAllProjectThreads}
                                    hoveredThreadActionId={hoveredThreadActionId}
                                    hasMore={projectCollapsed ? false : projectThreadsHaveMore}
                                    onArchiveThread={onArchiveThread}
                                    onPinThread={onPinThread}
                                    onSelectThread={(threadId) => onSelectThread(project.id, threadId)}
                                    onThreadActionHoverChange={onThreadActionHoverChange}
                                    onToggleExpanded={() => {
                                      if (
                                        (projectThreadsHaveMore && showAllProjectThreads) ||
                                        (!showAllProjectThreads && projectThreadsHaveMore)
                                      ) {
                                        onLoadMoreProjectThreads?.(project.id);
                                      }
                                      setExpandedThreadProjectIds((current) => {
                                        const next = new Set(current);
                                        if (next.has(project.id) && !projectThreadsHaveMore) {
                                          next.delete(project.id);
                                        } else {
                                          next.add(project.id);
                                        }
                                        return next;
                                      });
                                    }}
                                    onUnpinThread={onUnpinThread}
                                    pendingTitleThreadIds={pendingTitleThreadIds}
                                    paginationState={projectThreadPaginationState}
                                    selectedThreadId={selectedThreadId}
                                    threads={renderedProjectThreads}
                                  />
                                ) : null}
                              </Box>
                            );
                          })
                      ) : null}
                    </Stack>
                  ) : null}
                </>
              ) : null}
              {sidebarScope === "chats" ? (
                <Box className="kodex-sidebar-section">
                  <SidebarSectionDisclosureRow
                    className="kodex-chats-section-row"
                    collapsed={chatsSectionCollapsed}
                    label={SIDEBAR_TEXT.chats}
                    onToggle={() => handleSectionCollapseToggle("chatsSectionCollapsed")}
                    trailingActions={[{ icon: <SquarePen />, label: SIDEBAR_TEXT.newChat, onClick: onCreateChat }]}
                  />
                  {!chatsSectionCollapsed && visibleChatThreads.length > 0 ? (
                    <ThreadList
                      approvals={approvals}
                      className="kodex-chat-thread-list"
                      expanded={chatThreadsExpanded}
                      hasMore={chatThreadsHasMore}
                      hoveredThreadActionId={hoveredThreadActionId}
                      onArchiveThread={onArchiveThread}
                      onPinThread={onPinThread}
                      onSelectThread={onSelectChatThread}
                      onThreadActionHoverChange={onThreadActionHoverChange}
                      onToggleExpanded={() => {
                        if (chatThreadsHasMore) {
                          onLoadMoreChatThreads?.();
                        }
                        setChatThreadsExpanded((expanded) => (expanded && !chatThreadsHasMore ? false : true));
                      }}
                      onUnpinThread={onUnpinThread}
                      pendingTitleThreadIds={pendingTitleThreadIds}
                      paginationState={chatThreadsPaginationState}
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
              ) : null}
              </Box>
            </Box>
          </>
        ) : (
          <CollapsedSidebarRail
            onExpand={onSidebarExpandClick}
            onOpenTerminal={onOpenTerminal}
            onRecentThreadSelect={handleRecentThreadSelect}
            onSearch={handleCollapsedSearchClick}
            recentThreads={recentThreads}
          />
        )}
      </Stack>
    </AppShell.Navbar>
  );
});

function SearchActionRow({
  active,
  inputRef,
  onActivate,
  onBlur,
  onChange,
  query,
}: {
  active: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onActivate: () => void;
  onBlur: () => void;
  onChange: (value: string) => void;
  query: string;
}) {
  return active ? (
    <SidebarTextInputRow
      icon={<Search aria-hidden="true" />}
      inputRef={inputRef}
      inputProps={{
        "aria-label": SIDEBAR_TEXT.search,
        onBlur,
        onChange: (event) => onChange(event.currentTarget.value),
        placeholder: SIDEBAR_TEXT.search,
        value: query,
      }}
    />
  ) : (
    <SidebarTextActionRow icon={<Search aria-hidden="true" />} label={SIDEBAR_TEXT.search} onClick={onActivate} />
  );
}

function CollapsedSidebarRail({
  onExpand,
  onOpenTerminal,
  onRecentThreadSelect,
  onSearch,
  recentThreads,
}: {
  onExpand: () => void;
  onOpenTerminal?: () => void;
  onRecentThreadSelect: (thread: RecentSidebarThread) => void;
  onSearch: () => void;
  recentThreads: RecentSidebarThread[];
}) {
  return (
    <Box className="kodex-sidebar-collapsed-rail">
      <Box className="kodex-sidebar-collapsed-header">
        <SidebarIconButton
          className="kodex-sidebar-collapsed-button"
          label={SIDEBAR_TEXT.expandSidebarHandle}
          onClick={onExpand}
        >
          <PanelLeftOpen />
        </SidebarIconButton>
      </Box>
      <Box className="kodex-sidebar-collapsed-actions" aria-label="Collapsed sidebar actions">
        <SidebarIconButton className="kodex-sidebar-collapsed-button" label={SIDEBAR_TEXT.search} onClick={onSearch}>
          <Search />
        </SidebarIconButton>
        {onOpenTerminal ? (
          <SidebarIconButton
            className="kodex-sidebar-collapsed-button"
            label={SIDEBAR_TEXT.openTerminal}
            onClick={onOpenTerminal}
          >
            <SquareTerminal />
          </SidebarIconButton>
        ) : null}
        <Menu position="right-start" withinPortal>
          <Menu.Target>
            <SidebarIconButton
              className="kodex-sidebar-collapsed-button"
              label={SIDEBAR_TEXT.recentThreads}
              tooltip={false}
            >
              <MessageSquare size={16} />
            </SidebarIconButton>
          </Menu.Target>
          <Menu.Dropdown aria-label={SIDEBAR_TEXT.recentThreads} className="kodex-sidebar-recents-dropdown">
            <Menu.Label>{SIDEBAR_TEXT.recents}</Menu.Label>
            {recentThreads.length > 0 ? (
              recentThreads.map((recent) => (
                <Menu.Item key={recent.thread.id} onClick={() => onRecentThreadSelect(recent)}>
                  {threadDisplayTitle(recent.thread)}
                </Menu.Item>
              ))
            ) : (
              <Menu.Item disabled>No recent threads</Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      </Box>
    </Box>
  );
}

function projectDirectoryDisplayPath(projectCwd: string): string {
  const cwd = projectCwd.trim();
  if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("/")) {
    return cwd;
  }
  return `~/${cwd}`;
}

function sidebarProjectScopeLookup(projects: Project[]): { projectCwds: Set<string>; projectIds: Set<string> } {
  return {
    projectCwds: new Set(projects.map((project) => project.cwd)),
    projectIds: new Set(projects.map((project) => project.id)),
  };
}

function pinnedThreadBelongsToProject(
  thread: ThreadSummary,
  { projectCwds, projectIds }: { projectCwds: Set<string>; projectIds: Set<string> },
): boolean {
  const projectId = (thread as { projectId?: unknown }).projectId;
  return (typeof projectId === "string" && projectIds.has(projectId)) || projectCwds.has(thread.cwd);
}

type RecentSidebarThread = {
  location: { kind: "chat" } | { kind: "pinned" } | { kind: "project"; projectId: string };
  thread: ThreadSummary;
};

function recentSidebarThreads({
  chatThreads,
  pinnedThreads,
  projects,
  threadsByProjectId,
}: {
  chatThreads: ThreadSummary[];
  pinnedThreads: ThreadSummary[];
  projects: Project[];
  threadsByProjectId: ThreadsByProjectId;
}): RecentSidebarThread[] {
  const byThreadId = new Map<string, RecentSidebarThread>();
  for (const [projectId, threads] of Object.entries(threadsByProjectId)) {
    for (const thread of threads) {
      byThreadId.set(thread.id, { location: { kind: "project", projectId }, thread });
    }
  }
  for (const thread of chatThreads) {
    if (!byThreadId.has(thread.id)) {
      byThreadId.set(thread.id, { location: { kind: "chat" }, thread });
    }
  }
  const projectByCwd = new Map(projects.map((project) => [project.cwd, project.id]));
  for (const thread of pinnedThreads) {
    if (byThreadId.has(thread.id)) {
      continue;
    }
    const projectId = projectByCwd.get(thread.cwd);
    byThreadId.set(thread.id, {
      location: projectId ? { kind: "project", projectId } : { kind: "pinned" },
      thread,
    });
  }
  return [...byThreadId.values()]
    .sort(
      (left, right) =>
        right.thread.updatedAt - left.thread.updatedAt ||
        right.thread.createdAt - left.thread.createdAt ||
        threadDisplayTitle(left.thread).localeCompare(threadDisplayTitle(right.thread)) ||
        left.thread.id.localeCompare(right.thread.id),
    )
    .slice(0, 10);
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

function threadSurfacesWhenProjectCollapsed(thread: ThreadSummary, selectedThreadId: string | null): boolean {
  return Boolean(thread.pinnedAt) || thread.id === selectedThreadId || thread.unreadCompletedAgentTurn === true || threadInProgress(thread);
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
  const focusPointerType = useRef<string | null>(null);

  function handleHoverPointerDown(event: ReactPointerEvent<HTMLElement>) {
    focusPointerType.current = event.pointerType;
  }

  function handleHoverPointerEnter(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") {
      onThreadActionHoverChange(thread.id);
    }
  }

  function handleHoverPointerLeave(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") {
      onThreadActionHoverChange(null);
    }
  }

  return (
    <SidebarRowFrame
      className="kodex-ui-selectable kodex-list-button kodex-thread-list-button"
      leadingContent={
        <SidebarIconButton
          className="kodex-thread-pin-button"
          data-pinned={isPinned ? "true" : undefined}
          density="compact"
          label={pinLabel}
          onClick={(event) => {
            event.stopPropagation();
            if (isPinned) {
              onUnpinThread(thread.id);
            } else {
              onPinThread(thread.id);
            }
          }}
        >
          {isPinned ? (
            <>
              <Pin className="kodex-thread-pin-state-icon" />
              <PinOff className="kodex-thread-pin-action-icon" />
            </>
          ) : (
            <Pin />
          )}
        </SidebarIconButton>
      }
      rootProps={{
        "data-active": isSelected ? "true" : undefined,
        "data-pinned": isPinned ? "true" : undefined,
        onBlur: (event) => {
          focusPointerType.current = null;
          if (!event.currentTarget.contains(event.relatedTarget)) {
            onThreadActionHoverChange(null);
          }
        },
        onFocus: () => {
          if (focusPointerType.current !== "touch" && focusPointerType.current !== "pen") {
            onThreadActionHoverChange(thread.id);
          }
        },
        onPointerDown: handleHoverPointerDown,
        onPointerEnter: handleHoverPointerEnter,
        onPointerLeave: handleHoverPointerLeave,
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
            <SidebarIconButton
              className="kodex-thread-archive-button"
              density="compact"
              label={`Archive ${displayTitle}`}
              tooltip="Archive thread"
              onClick={() => onArchiveThread(thread.id)}
            >
              <Archive />
            </SidebarIconButton>
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
  hasMore = false,
  hoveredThreadActionId,
  onArchiveThread,
  onPinThread,
  onSelectThread,
  onThreadActionHoverChange,
  onToggleExpanded,
  onUnpinThread,
  pendingTitleThreadIds,
  paginationState = "idle",
  selectedThreadId,
  threads,
}: {
  approvals: Approval[];
  className: string;
  expanded: boolean;
  hasMore?: boolean;
  hoveredThreadActionId: string | null;
  onArchiveThread: (threadId: string) => void;
  onPinThread: (threadId: string) => void;
  onSelectThread: (threadId: string) => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onToggleExpanded: () => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  paginationState?: SidebarPaginationState;
  selectedThreadId: string | null;
  threads: ThreadSummary[];
}) {
  const visibleThreads = expanded ? threads : threads.slice(0, VISIBLE_THREAD_LIMIT);
  const hasHiddenThreads = threads.length > VISIBLE_THREAD_LIMIT || hasMore;
  const toggleLabel =
    paginationState === "loading"
      ? SIDEBAR_TEXT.showMoreLoading
      : expanded && !hasMore
        ? SIDEBAR_TEXT.showLessThreads
        : SIDEBAR_TEXT.showMoreThreads;

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
        <button
          className="kodex-ui-button kodex-thread-list-more-button"
          disabled={paginationState === "loading"}
          onClick={onToggleExpanded}
          type="button"
        >
          {toggleLabel}
        </button>
      ) : null}
      {paginationState === "error" ? (
        <Text c="red" role="alert" size="xs">
          {SIDEBAR_TEXT.showMoreError}
        </Text>
      ) : null}
    </Stack>
  );
}
