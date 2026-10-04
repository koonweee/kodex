import { Alert, Box, Button, Menu, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { createThreadSection, deleteThreadSection, renameThreadSection, type ThreadSection, type ThreadSummary } from "../api/client";
import { refreshProjectState } from "../projects/cache";
import { errorMessageFrom } from "../shared/values";
import { threadDisplayTitle } from "../threads/helpers";
import { SidebarIconButton } from "../threads/SidebarIconButton";
import { SidebarRowFrame } from "../threads/sidebarRows";
import { ThreadList } from "../threads/ThreadSidebarRows";
import { PINNED_SECTION_ID } from "./cache";

type Props = Omit<ComponentProps<typeof ThreadList>, "threads" | "expanded" | "onToggleExpanded" | "className" | "sections"> & {
  sections: ThreadSection[];
  threadsBySectionId: Record<string, ThreadSummary[]>;
  collapsedSectionIds: Set<string>;
  onToggleSection: (id: string) => void;
  searchQuery: string;
  hasMoreById: Record<string, boolean>;
  paginationStates: Record<string, "idle" | "loading" | "error">;
  onLoadMore?: (id: string) => void;
  onSectionsChanged?: () => void;
};

export function NativeSectionsSidebar({ sections, threadsBySectionId, collapsedSectionIds, onToggleSection,
  searchQuery, hasMoreById, paginationStates, onLoadMore, onSectionsChanged, ...rowProps
}: Props) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<ThreadSection | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<ThreadSection | null>(null);
  const [name, setName] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  async function refresh() { onSectionsChanged?.(); await refreshProjectState(client); }
  const save = useMutation({
    mutationFn: () => editing ? renameThreadSection(editing.id, name.trim()) : createThreadSection(name.trim()),
    onSuccess: async () => { setEditing(undefined); await refresh(); },
  });
  const remove = useMutation({
    mutationFn: (sectionId: string) => deleteThreadSection(sectionId),
    onSuccess: async () => { setDeleting(null); await refresh(); },
  });
  function edit(section: ThreadSection | null) { save.reset(); setName(section?.name ?? ""); setEditing(section); }
  return <>
    <Button variant="subtle" size="compact-xs" leftSection={<Plus size={14} />} onClick={() => edit(null)}>Add section</Button>
    {sections.map((section) => {
      const order = threadsBySectionId[section.id] ?? [];
      const matches = !searchQuery || section.name.toLowerCase().includes(searchQuery);
      const rows = matches ? order : order.filter((thread) => threadDisplayTitle(thread).toLowerCase().includes(searchQuery));
      if (!matches && rows.length === 0) return null;
      const collapsed = collapsedSectionIds.has(section.id);
      return <Box className="kodex-native-section" key={section.id} role="group" aria-label={`${section.name} section`}>
        <SidebarRowFrame className="kodex-sidebar-section-row" collapsed={collapsed} trailingContent={section.id !== PINNED_SECTION_ID ? <Menu position="bottom-end" withinPortal>
          <Menu.Target><SidebarIconButton density="compact" label={`Section actions for ${section.name}`} tooltip={false}><MoreHorizontal /></SidebarIconButton></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => edit(section)}>Rename section</Menu.Item>
            <Menu.Item color="red" onClick={() => { remove.reset(); setDeleting(section); }}>Delete section</Menu.Item>
          </Menu.Dropdown>
        </Menu> : undefined}>
          <button aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${section.name} section`} className="kodex-ui-button kodex-sidebar-row-main kodex-sidebar-section-toggle" onClick={() => onToggleSection(section.id)} type="button">
            <Text component="span" className="kodex-sidebar-row-label" size="xs">{section.name}</Text>
          </button>
        </SidebarRowFrame>
        {!collapsed ? <ThreadList {...rowProps} sections={sections} threads={rows} sectionOrder={order}
          className="kodex-section-thread-list" expanded={expandedIds.has(section.id) || Boolean(searchQuery)} hasMore={hasMoreById[section.id]}
          paginationState={paginationStates[section.id]} onToggleExpanded={() => {
            if (hasMoreById[section.id]) { setExpandedIds((current) => new Set(current).add(section.id)); onLoadMore?.(section.id); }
            else setExpandedIds((current) => { const next = new Set(current); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; });
          }} /> : null}
      </Box>;
    })}
    <Modal opened={editing !== undefined} onClose={() => !save.isPending && setEditing(undefined)} title={editing ? "Rename section" : "Add section"}>
      <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}><Stack>
        <TextInput label="Section name" value={name} onChange={(event) => setName(event.currentTarget.value)} required disabled={save.isPending} />
        {save.error ? <Alert color="red">{errorMessageFrom(save.error)}</Alert> : null}
        <Button type="submit" loading={save.isPending} disabled={!name.trim()}>{editing ? "Save section" : "Create section"}</Button>
      </Stack></form>
    </Modal>
    <Modal opened={deleting !== null} onClose={() => !remove.isPending && setDeleting(null)} title={`Delete ${deleting?.name ?? "section"}?`}>
      <Stack><Text>Chats in this section will return to their project or Chats list.</Text>
        {remove.error ? <Alert color="red">{errorMessageFrom(remove.error)}</Alert> : null}
        <Button color="red" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>Delete section</Button>
      </Stack>
    </Modal>
  </>;
}
