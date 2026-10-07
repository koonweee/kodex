import { SidebarPeek } from "./SidebarPeek";
import { SidebarSnapshotError, type SidebarSnapshotStatus } from "./SidebarSnapshotError";
import { ThreadList } from "./ThreadSidebarRows";
import { CollapsedSidebarRail, recentSidebarThreads, type RecentSidebarThread } from "./CollapsedSidebarRail";
import { PinnedThreadsSidebar } from "./PinnedThreadsSidebar";
import type { PinnedThreadActions } from "./PinnedOrderMenuItems";
import {
  AppShell,
  Box,
  Stack,
  Text,
} from "@mantine/core";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  MessageSquare,
  PanelLeftClose,
  Search,
  Settings,
  SquarePen,
  SquareTerminal,
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
  type RefObject,
} from "react";

import type { AccountResponse, Approval, Project, ThreadSummary } from "../api/client";
import { useGatewayInstanceStorage } from "../api/GatewayInstanceBoundary";
import type { UsageLimitLines } from "../account/rateLimits";
import { SidebarAccountMenu } from "../account/SidebarAccountFooter";
import { useInputCapabilities } from "../shared/inputCapabilities";
import { useNarrowWorkspace } from "../shared/layoutBreakpoints";
import { AdaptiveIcon } from "../ui/AdaptiveIcon";
import { EmptyPanel } from "../ui/EmptyPanel";
import {
  threadDisplayTitle,
  threadInProgress,
  type ThreadsByProjectId,
} from "./helpers";
import { moveProjectInSidebarOrderAt } from "../projects/dragOrder";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  loadSidebarDisclosureState,
  saveSidebarDisclosureState,
  type SidebarDisclosureState,
} from "./sidebarDisclosureState";
import {
  SidebarActionDisclosureRow,
  SidebarSectionDisclosureRow,
  SidebarTextActionRow,
  SidebarTextInputRow,
} from "./sidebarRows";

const SIDEBAR_TEXT = {
  chats: "Chats",
  collapseSidebar: "Collapse workspace sidebar",
  newChat: "New chat",
  newProject: "Add project",
  newThread: "New thread",
  noProjectsText: "Create a project to begin.",
  noProjectsTitle: "No projects",
  projects: "Projects",
  search: "Search",
  showThread: "Show thread",
  workspaceLabel: "Workspace",
};

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
  sidebarSnapshotStatus,
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
  onMoveProject,
  onSelectAutomations,
  onSelectChatThread,
  onSelectPinnedThread,
  onSelectProjectSettings,
  onSelectThread,
  onShowThread = () => undefined,
  onShowDebugEventsChange,
  onShowCommandOutputsChange,
  onSidebarCollapseClick,
  onSidebarExpandClick,
  onThreadActionHoverChange,
  onUnpinThread,
  pinnedThreads, pinnedThreadsHasMore = false, pinnedThreadsPaginationState = "idle", onLoadMorePinnedThreads, onMovePinnedThread, pinPending,
  pendingTitleThreadIds,
  projectThreadHasMoreById = {},
  projectThreadPaginationStateById = {},
  projects,
  selectedProjectId,
  selectedMainPane,
  selectedThreadId,
  showDebugEvents,
  showCommandOutputs = false,
  sidebarCollapsed = false,
  sidebarWidth,
  threadsByProjectId,
  usageLimitLines,
}: PinnedThreadActions & {
  pinnedThreadsHasMore?: boolean;
  pinnedThreadsPaginationState?: SidebarPaginationState;
  onLoadMorePinnedThreads?: () => void;
  account: AccountResponse | null;
  approvals: Approval[];
  chatThreads: ThreadSummary[];
  chatThreadsHasMore?: boolean;
  chatThreadsPaginationState?: SidebarPaginationState;
  dataState?: WorkspaceSidebarDataState;
  sidebarSnapshotStatus?: SidebarSnapshotStatus;
  hoveredThreadActionId: string | null;
  onArchiveThread: (threadId: string) => void;
  onCreateChat: () => void;
  onCreateProject: () => void;
  onCreateThread: (projectId: string) => void;
  onLogout: () => void;
  onLoadMoreChatThreads?: () => void;
  onLoadMoreProjectThreads?: (projectId: string) => void;
  onOpenPreferences: () => void;
  onOpenTerminal?: () => void;
  onPinThread: (threadId: string) => void;
  onMoveProject: (projectId: string, beforeProjectId: string | null) => void;
  onSelectAutomations: () => void;
  onSelectChatThread: (threadId: string) => void;
  onSelectPinnedThread: (threadId: string) => void;
  onSelectProjectSettings: (projectId: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onShowThread?: () => void;
  onShowDebugEventsChange: (value: boolean) => void;
  onShowCommandOutputsChange?: (value: boolean) => void;
  onSidebarCollapseClick: () => void;
  onSidebarExpandClick: () => void;
  onThreadActionHoverChange: (threadId: string | null) => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  pinnedThreads: ThreadSummary[];
  projectThreadHasMoreById?: Record<string, boolean>;
  projectThreadPaginationStateById?: Record<string, SidebarPaginationState>;
  projects: Project[];
  selectedProjectId: string | null;
  selectedMainPane: "thread" | "automations" | "project";
  selectedThreadId: string | null;
  showDebugEvents: boolean;
  showCommandOutputs?: boolean;
  sidebarCollapsed?: boolean;
  sidebarWidth: number;
  threadsByProjectId: ThreadsByProjectId;
  usageLimitLines?: UsageLimitLines | null;
}) {
  const instanceStorage = useGatewayInstanceStorage();
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [sidebarDisclosureState, setSidebarDisclosureState] = useState<SidebarDisclosureState>(() =>
    loadSidebarDisclosureState(instanceStorage),
  );
  const [chatThreadsExpanded, setChatThreadsExpanded] = useState(false);
  const [expandedThreadProjectIds, setExpandedThreadProjectIds] = useState<Set<string>>(() => new Set());
  const [sidebarScope, setSidebarScope] = useState<SidebarScope>("projects");
  const [previewProjectIds, setPreviewProjectIds] = useState<string[] | null>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarScrollState, setSidebarScrollState] = useState({ bottom: false, stickyProjectHeader: false, top: false });
  const isNarrowWorkspace = useNarrowWorkspace();
  const { hasTouchInput: useTouchDensity, hasPrimaryFineHover } = useInputCapabilities();
  const projectGroupRefs = useRef<Map<string, HTMLElement>>(new Map());
  const pendingProjectAnimationRects = useRef<Map<string, DOMRect> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sidebarScrollElement, setSidebarScrollElement] = useState<HTMLDivElement | null>(null);
  const displayedProjects = useMemo(
    () => projectsFromPreviewOrder(projects, previewProjectIds),
    [previewProjectIds, projects],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleChatThreads = chatThreads.filter((thread) => !thread.pinned && (!normalizedSearchQuery || threadMatchesSearch(thread, normalizedSearchQuery, pendingTitleThreadIds)));
  const {
    chatsSectionCollapsed,
    collapsedProjectIds,
    pinnedCollapsed,
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
    if (!searchActive) {
      return;
    }
    searchInputRef.current?.focus();
  }, [searchActive, sidebarCollapsed]);

  const updateSidebarScrollEdges = useCallback(() => {
    const element = sidebarScrollElement;
    if (!element) {
      setSidebarScrollState((current) =>
        current.bottom || current.stickyProjectHeader || current.top
          ? { bottom: false, stickyProjectHeader: false, top: false }
          : current,
      );
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
  }, [sidebarScrollElement]);

  useEffect(() => {
    const element = sidebarScrollElement;
    if (!element) {
      setSidebarScrollState((current) =>
        current.bottom || current.stickyProjectHeader || current.top
          ? { bottom: false, stickyProjectHeader: false, top: false }
          : current,
      );
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
  }, [sidebarScrollElement, updateSidebarScrollEdges]);

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
    onMoveProject(sourceProjectId, nextProjectIds[nextProjectIds.indexOf(sourceProjectId) + 1] ?? null);
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
    section: "chatsSectionCollapsed" | "projectsSectionCollapsed",
  ) {
    updateSidebarDisclosureState((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  function updateSidebarDisclosureState(updater: (current: SidebarDisclosureState) => SidebarDisclosureState) {
    setSidebarDisclosureState((current) => {
      const next = updater(current);
      saveSidebarDisclosureState(next, instanceStorage);
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
      p="xs"
      className="kodex-sidebar"
      data-density={useTouchDensity ? "touch" : "compact"}
      data-main-pane={selectedMainPane}
      data-collapsed={sidebarCollapsed ? "true" : undefined}
      data-sidebar-scope={sidebarScope}
      style={{ width: sidebarWidth }}
    >
      <SidebarPeek collapsed={sidebarCollapsed} enabled={hasPrimaryFineHover && !isNarrowWorkspace}
        rail={(handlers) => <CollapsedSidebarRail
          onExpand={onSidebarExpandClick}
          onExpandPointerEnter={handlers.onPointerEnter}
          onExpandPointerLeave={handlers.onPointerLeave}
          onOpenTerminal={onOpenTerminal}
          onRecentThreadSelect={handleRecentThreadSelect}
          onSearch={handleCollapsedSearchClick}
          recentThreads={recentThreads}
        />}>
        <Stack gap={isNarrowWorkspace ? 8 : "lg"} h="100%">
            <Box className="kodex-sidebar-header">
              <SidebarAccountMenu
                account={account}
                onLogout={onLogout}
                onSelectAutomations={onSelectAutomations}
                onOpenPreferences={onOpenPreferences}
                onShowDebugEventsChange={onShowDebugEventsChange}
                showDebugEvents={showDebugEvents}
                onShowCommandOutputsChange={onShowCommandOutputsChange}
                showCommandOutputs={showCommandOutputs}
                usageLimitLines={usageLimitLines}
              />
              {!sidebarCollapsed ? <SidebarIconButton
                className="kodex-sidebar-header-action"
                label={isNarrowWorkspace ? SIDEBAR_TEXT.showThread : SIDEBAR_TEXT.collapseSidebar}
                onClick={isNarrowWorkspace ? onShowThread : onSidebarCollapseClick}
                tooltipProps={{ position: isNarrowWorkspace ? "bottom" : "right" }}
              >
                <PanelLeftClose size={16} />
              </SidebarIconButton> : null}
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
            <SidebarSnapshotError status={sidebarSnapshotStatus} />
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
                ref={setSidebarScrollElement}
              >
                <PinnedThreadsSidebar
                  threads={pinnedThreads} collapsed={pinnedCollapsed}
                  onToggle={() => updateSidebarDisclosureState((current) => ({ ...current, pinnedCollapsed: !current.pinnedCollapsed }))}
                  searchQuery={normalizedSearchQuery} hasMore={pinnedThreadsHasMore} paginationState={pinnedThreadsPaginationState}
                  onLoadMore={onLoadMorePinnedThreads} approvals={approvals} hoveredThreadActionId={hoveredThreadActionId}
                  onArchiveThread={onArchiveThread} onPinThread={onPinThread} onUnpinThread={onUnpinThread}
                  onMovePinnedThread={onMovePinnedThread} pinPending={pinPending}
                  onSelectThread={onSelectPinnedThread} onThreadActionHoverChange={onThreadActionHoverChange}
                  pendingTitleThreadIds={pendingTitleThreadIds} selectedThreadId={selectedThreadId}
                />
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
                          onClick: onCreateProject,
                        },
                      ]}
                    />
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
                            const projectThreads = (threadsByProjectId[project.id] ?? []).filter((thread) => !thread.pinned);
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
                                {renderedProjectThreads.length > 0 || (!projectCollapsed && projectThreadsHaveMore) ? (
                                  <ThreadList
                          pinPending={pinPending}
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
                  {!chatsSectionCollapsed && (visibleChatThreads.length > 0 || chatThreadsHasMore) ? (
                    <ThreadList
                                pinPending={pinPending}
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
        </Stack>
      </SidebarPeek>
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
  return thread.id === selectedThreadId || thread.unreadCompletedAgentTurn === true || threadInProgress(thread);
}

function threadDisplayTitleWithPending(thread: ThreadSummary, pendingTitleThreadIds: Set<string>): string {
  return pendingTitleThreadIds.has(thread.id) ? SIDEBAR_TEXT.newThread : threadDisplayTitle(thread);
}
