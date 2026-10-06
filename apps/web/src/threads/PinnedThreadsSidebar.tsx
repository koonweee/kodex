import { Box } from "@mantine/core";
import { useState, type ComponentProps } from "react";

import { threadDisplayTitle } from "./helpers";
import { SidebarSectionDisclosureRow } from "./sidebarRows";
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
  if ((threads.length === 0 && !hasMore) || (!matches && rows.length === 0)) return null;
  return <Box className="kodex-pinned-threads" role="group" aria-label="Pinned">
    <SidebarSectionDisclosureRow collapsed={collapsed} label="Pinned" onToggle={onToggle} />
    {!collapsed ? <ThreadList {...rowProps} threads={rows} pinnedOrder={threads}
      className="kodex-pinned-thread-list" expanded={expanded || Boolean(searchQuery)} hasMore={hasMore}
      onToggleExpanded={() => {
        if (hasMore) { setExpanded(true); onLoadMore?.(); }
        else setExpanded((current) => !current);
      }} /> : null}
  </Box>;
}
