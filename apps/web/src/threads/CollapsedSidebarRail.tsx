import { Box, Menu } from "@mantine/core";
import { MessageSquare, PanelLeftOpen, Search, SquareTerminal } from "lucide-react";
import type { PointerEventHandler } from "react";

import type { Project, ThreadSummary } from "../api/client";
import { threadDisplayTitle, type ThreadsByProjectId } from "./helpers";
import { SidebarIconButton } from "./SidebarIconButton";

const SIDEBAR_TEXT = {
  expandSidebarHandle: "Expand workspace sidebar",
  openTerminal: "Open terminal",
  recentThreads: "Recent threads",
  recents: "Recents",
  search: "Search",
};

export function CollapsedSidebarRail({
  onExpand,
  onExpandPointerEnter,
  onExpandPointerLeave,
  onOpenTerminal,
  onRecentThreadSelect,
  onSearch,
  recentThreads,
}: {
  onExpand: () => void;
  onExpandPointerEnter?: PointerEventHandler<HTMLButtonElement>;
  onExpandPointerLeave?: PointerEventHandler<HTMLButtonElement>;
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
          onPointerEnter={onExpandPointerEnter}
          onPointerLeave={onExpandPointerLeave}
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

export type RecentSidebarThread = {
  location: { kind: "chat" } | { kind: "pinned" } | { kind: "project"; projectId: string };
  thread: ThreadSummary;
};

export function recentSidebarThreads({
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
  const projectIds = new Set(projects.map((project) => project.id));
  for (const thread of pinnedThreads) {
    if (byThreadId.has(thread.id)) {
      continue;
    }
    const projectId = thread.projectId && projectIds.has(thread.projectId) ? thread.projectId : null;
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

