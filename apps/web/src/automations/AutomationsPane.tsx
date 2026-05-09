import { ActionIcon, Badge, Box, Button, Group, Loader, Paper, Table, Text, Title, Tooltip } from "@mantine/core";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { PanelLeftOpen, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  Automation,
  AutomationCreateRequest,
  AutomationUpdateRequest,
} from "../api/client";
import { EmptyPanel } from "../ui/EmptyPanel";
import { AutomationEditorModal } from "./AutomationEditorModal";
import {
  formatAutomationDate,
  formatAutomationInterval,
} from "./schedule";
import type { AutomationThreadOption } from "./threadOptions";
import { threadLabelById } from "./threadOptions";

const AUTOMATIONS_TEXT = {
  add: "Add automation",
  addShort: "Automation",
  emptyText: "Create recurring prompts that enqueue into a target thread.",
  emptyTitle: "No automations",
  showSidebar: "Show sidebar",
  title: "Automations",
};

export function AutomationsPane({
  automations,
  defaultThreadId,
  isLoading,
  onCreateAutomation,
  onDeleteAutomation,
  onPauseAutomation,
  onResumeAutomation,
  onShowMobileSidebar,
  onUpdateAutomation,
  threadOptions,
}: {
  automations: Automation[];
  defaultThreadId: string | null;
  isLoading: boolean;
  onCreateAutomation: (request: AutomationCreateRequest) => Promise<Automation>;
  onDeleteAutomation: (automationId: string) => Promise<void>;
  onPauseAutomation: (automationId: string) => Promise<Automation>;
  onResumeAutomation: (automationId: string) => Promise<Automation>;
  onShowMobileSidebar: () => void;
  onUpdateAutomation: (automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
  threadOptions: AutomationThreadOption[];
}) {
  const [editingAutomation, setEditingAutomation] = useState<Automation | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const defaultTargetThreadId = defaultThreadId ?? threadOptions[0]?.value ?? null;
  const columns = useMemo<ColumnDef<Automation>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 220,
        cell: ({ row }) => (
          <Box>
            <Text fw={500} size="sm">
              {row.original.name}
            </Text>
            <Box className="kodex-automation-mobile-meta">
              <Text c="dimmed" size="xs">
                {threadLabelById(threadOptions, row.original.targetThreadId)}
              </Text>
              <Group gap="xs" mt={6} wrap="wrap">
                <Badge data-tone={row.original.status === "active" ? "success" : "neutral"} variant="light">
                  {row.original.status}
                </Badge>
                <Text c="dimmed" size="xs">
                  {formatAutomationInterval(row.original)}
                </Text>
                <Text c="dimmed" size="xs">
                  Next: {formatAutomationDate(row.original.nextRunAt)}
                </Text>
              </Group>
            </Box>
          </Box>
        ),
      },
      {
        accessorFn: (row) => threadLabelById(threadOptions, row.targetThreadId),
        header: "Target thread",
        id: "targetThread",
        size: 220,
      },
      {
        accessorKey: "status",
        header: "Status",
        size: 110,
        cell: ({ row }) => (
          <Badge data-tone={row.original.status === "active" ? "success" : "neutral"} variant="light">
            {row.original.status}
          </Badge>
        ),
      },
      {
        accessorFn: (row) => formatAutomationDate(row.nextRunAt),
        header: "Next run",
        id: "nextRunAt",
        size: 180,
      },
      {
        accessorFn: formatAutomationInterval,
        header: "Repeat",
        id: "repeat",
        size: 120,
      },
      {
        accessorFn: (row) => formatAutomationDate(row.lastRunAt),
        header: "Last run",
        id: "lastRunAt",
        size: 180,
      },
      {
        accessorFn: (row) => row.lastError ?? String(row.consecutiveFailureCount),
        header: "Failures",
        id: "failures",
        size: 170,
        cell: ({ row }) =>
          row.original.lastError ? (
            <Text className="kodex-ui-text" data-tone="danger" lineClamp={1} size="xs">
              {row.original.lastError}
            </Text>
          ) : (
            <Text c="dimmed" size="sm">
              {row.original.consecutiveFailureCount}
            </Text>
          ),
      },
    ],
    [threadOptions],
  );
  const table = useReactTable({
    columns,
    data: automations,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  function handleAdd() {
    setEditingAutomation(null);
    setEditorOpen(true);
  }

  function handleEdit(automation: Automation) {
    setEditingAutomation(automation);
    setEditorOpen(true);
  }

  return (
    <>
      <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-automations-header">
        <Group gap="xs" wrap="nowrap" className="kodex-thread-heading">
          <ActionIcon
            aria-label={AUTOMATIONS_TEXT.showSidebar}
            className="kodex-thread-sidebar-button"
            onClick={onShowMobileSidebar}
            variant="subtle"
          >
            <PanelLeftOpen size={17} />
          </ActionIcon>
          <Title className="kodex-thread-title" order={3} size="h5">
            {AUTOMATIONS_TEXT.title}
          </Title>
        </Group>
        <Tooltip label={AUTOMATIONS_TEXT.add}>
          <Button
            aria-label={AUTOMATIONS_TEXT.add}
            className="kodex-automations-add-button"
            leftSection={<Plus size={15} />}
            onClick={handleAdd}
            size="sm"
            type="button"
            variant="subtle"
          >
            {AUTOMATIONS_TEXT.addShort}
          </Button>
        </Tooltip>
      </Group>
      <Box className="kodex-automations-pane kodex-main-column">
        {automations.length === 0 && !isLoading ? (
          <Box className="kodex-automations-empty">
            <EmptyPanel
              icon={<Plus size={22} />}
              title={AUTOMATIONS_TEXT.emptyTitle}
              text={AUTOMATIONS_TEXT.emptyText}
            />
          </Box>
        ) : (
          <Paper className="kodex-mantine-paper-root kodex-automation-table-paper">
            <Box className="kodex-automation-table-container">
              <Table highlightOnHover stickyHeader>
                <Table.Thead>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <Table.Tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => {
                        const sortDirection = header.column.getIsSorted();
                        return (
                          <Table.Th key={header.id} style={{ width: header.getSize() }}>
                            <button
                              className="kodex-automation-sort-button"
                              disabled={!header.column.getCanSort()}
                              onClick={header.column.getToggleSortingHandler()}
                              type="button"
                            >
                              <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                              {sortDirection ? <span aria-hidden="true">{sortDirection === "asc" ? "↑" : "↓"}</span> : null}
                            </button>
                          </Table.Th>
                        );
                      })}
                    </Table.Tr>
                  ))}
                </Table.Thead>
                <Table.Tbody>
                  {isLoading ? (
                    <Table.Tr>
                      <Table.Td colSpan={columns.length}>
                        <Group justify="center" py="xl">
                          <Loader size="sm" />
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    table.getRowModel().rows.map((row) => (
                      <Table.Tr
                        className="kodex-automation-table-row"
                        key={row.id}
                        onClick={() => handleEdit(row.original)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleEdit(row.original);
                          }
                        }}
                        tabIndex={0}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <Table.Td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Td>
                        ))}
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Box>
          </Paper>
        )}
      </Box>
      <AutomationEditorModal
        automation={editingAutomation}
        fallbackThreadId={defaultTargetThreadId}
        onClose={() => setEditorOpen(false)}
        onCreate={onCreateAutomation}
        onDelete={onDeleteAutomation}
        onPause={async (automationId) => {
          const automation = await onPauseAutomation(automationId);
          setEditingAutomation(automation);
        }}
        onResume={async (automationId) => {
          const automation = await onResumeAutomation(automationId);
          setEditingAutomation(automation);
        }}
        onUpdate={onUpdateAutomation}
        opened={editorOpen}
        threadOptions={threadOptions}
      />
    </>
  );
}
