import { Box, Text } from "@mantine/core";
import { useState, type ComponentProps } from "react";

import { threadDisplayTitle } from "./helpers";
import { SidebarRowFrame } from "./sidebarRows";
import { ThreadList } from "./ThreadSidebarRows";

type Props = Omit<ComponentProps<typeof ThreadList>, "expanded" | "onToggleExpanded" | "className"> & {
  collapsed: boolean;
  onToggle: () => void;
  searchQuery: string;
  onLoadMore?: () => void;
};

export function PinnedThreadsSidebar({ threads, collapsed, onToggle, searchQuery, hasMore, onLoadMore, ...rowProps }: Props) {
  const [expanded, setExpanded] = useState(false);
  const matches = !searchQuery || "pinned".includes(searchQuery);
  const rows = matches ? threads : threads.filter((thread) => threadDisplayTitle(thread).toLowerCase().includes(searchQuery));
  if (!matches && rows.length === 0) return null;
  return <Box className="kodex-pinned-threads" role="group" aria-label="Pinned">
    <SidebarRowFrame className="kodex-sidebar-section-row" collapsed={collapsed}>
      <button aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} Pinned`} className="kodex-ui-button kodex-sidebar-row-main kodex-sidebar-section-toggle" onClick={onToggle} type="button">
        <Text component="span" className="kodex-sidebar-row-label" size="xs">Pinned</Text>
      </button>
    </SidebarRowFrame>
    {!collapsed ? <ThreadList {...rowProps} threads={rows} pinnedOrder={threads}
      className="kodex-pinned-thread-list" expanded={expanded || Boolean(searchQuery)} hasMore={hasMore}
      onToggleExpanded={() => {
        if (hasMore) { setExpanded(true); onLoadMore?.(); }
        else setExpanded((current) => !current);
      }} /> : null}
  </Box>;
}
