import { Badge, Box, Button, Group, Loader, Paper, Table, Text, Title, Tooltip } from "@mantine/core";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { PanelLeftOpen, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  Automation,
  AutomationCreateRequest,
  AutomationUpdateRequest,
} from "../api/client";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { EmptyPanel } from "../ui/EmptyPanel";
import { AutomationEditorModal, type CalendarAutomationEditorProps } from "./AutomationEditorModal";
import {
  formatAutomationDate,
  formatAutomationInterval,
} from "./schedule";
import type { AutomationThreadOption } from "./threadOptions";
import { threadLabelById } from "./threadOptions";

import type { NativeAutomation } from "../mastra/nativeAutomationTypes";

type AutomationRow = Automation | NativeAutomation;
type CommonPaneProps = {
  defaultThreadId: string | null;
  isLoading: boolean;
  onDeleteAutomation: (automationId: string) => Promise<void>;
  onShowMobileSidebar: () => void;
  threadOptions: AutomationThreadOption[];
  renderRuns?: (automationId: string) => ReactNode;
};
type IntervalPaneProps = CommonPaneProps & {
  mode?: "interval";
  automations: Automation[];
  onCreateAutomation: (request: AutomationCreateRequest) => Promise<Automation>;
  onPauseAutomation: (automationId: string) => Promise<Automation>;
  onResumeAutomation: (automationId: string) => Promise<Automation>;
  onUpdateAutomation: (automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
};
type CalendarPaneProps = CommonPaneProps & {
  mode: "calendar";
  automations: NativeAutomation[];
  targetReadOnly: boolean;
  onCreateAutomation: CalendarAutomationEditorProps["onCreate"];
  onPauseAutomation: (automationId: string) => Promise<NativeAutomation>;
  onResumeAutomation: (automationId: string) => Promise<NativeAutomation>;
  onUpdateAutomation: CalendarAutomationEditorProps["onUpdate"];
  renderRuns: (automationId: string) => ReactNode;
};

function calendarDate(value: number | undefined) {
  return formatAutomationDate(value === undefined ? undefined : new Date(value).toISOString());
}
function nextDate(row: AutomationRow) {
  return "cron" in row ? row.status === "completed" ? "Completed" : calendarDate(row.nextFireAt) : formatAutomationDate(row.nextRunAt);
}
function lastDate(row: AutomationRow) {
  return "cron" in row ? calendarDate(row.lastFireAt) : formatAutomationDate(row.lastRunAt);
}
function scheduleLabel(row: AutomationRow) {
  return "cron" in row ? `${row.cron} (${row.timezone ?? "Native default"})` : formatAutomationInterval(row);
}

const AUTOMATIONS_TEXT = {
  add: "Add automation",
  addShort: "Automation",
  emptyText: "Create recurring prompts that enqueue into a target thread.",
  emptyTitle: "No automations",
  showSidebar: "Show sidebar",
  title: "Automations",
};

export function AutomationsPane(props: IntervalPaneProps | CalendarPaneProps) {
  const { automations, defaultThreadId, isLoading, onShowMobileSidebar, threadOptions } = props;
  const [editingAutomation, setEditingAutomation] = useState<AutomationRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const defaultTargetThreadId = defaultThreadId ?? threadOptions[0]?.value ?? null;
  const columns = useMemo<ColumnDef<AutomationRow>[]>(
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
                  {scheduleLabel(row.original)}
                </Text>
                <Text c="dimmed" size="xs">
                  Next: {nextDate(row.original)}
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
        accessorFn: nextDate,
        header: "Next run",
        id: "nextRunAt",
        size: 180,
      },
      {
        accessorFn: scheduleLabel,
        header: props.mode === "calendar" ? "Schedule" : "Repeat",
        id: "repeat",
        size: 120,
      },
      {
        accessorFn: lastDate,
        header: "Last run",
        id: "lastRunAt",
        size: 180,
      },
      ...(props.mode === "calendar" ? [] : [{
        accessorFn: (row: AutomationRow) => "schedule" in row ? row.lastError ?? String(row.consecutiveFailureCount) : "",
        header: "Failures",
        id: "failures",
        size: 170,
        cell: ({ row }) => "schedule" in row.original ? row.original.lastError
          ? <Text className="kodex-ui-text" data-tone="danger" lineClamp={1} size="xs">{row.original.lastError}</Text>
          : <Text c="dimmed" size="sm">{row.original.consecutiveFailureCount}</Text> : null,
      } satisfies ColumnDef<AutomationRow>]),
    ],
    [props.mode, threadOptions],
  );
  // Accessor values are cached on rows, including target labels from the catalog.
  const tableRows = useMemo(() => [...automations], [automations, columns]);
  const table = useReactTable<AutomationRow>({
    columns,
    data: tableRows,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  const calendarEditing = props.mode === "calendar" && editingAutomation
    ? props.automations.find(row => row.id === editingAutomation.id) ?? null : null;
  useEffect(() => {
    if (props.mode === "calendar" && editingAutomation && !calendarEditing && !isLoading) {
      setEditingAutomation(null); setEditorOpen(false);
    }
  }, [props.mode, editingAutomation, calendarEditing, isLoading]);

  function handleAdd() {
    setEditingAutomation(null);
    setEditorOpen(true);
  }

  function handleEdit(automation: AutomationRow) {
    setEditingAutomation(automation);
    setEditorOpen(true);
  }

  return (
    <>
      <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-automations-header">
        <Group gap="xs" wrap="nowrap" className="kodex-thread-heading">
          <AdaptiveIconButton
            className="kodex-automations-sidebar-button"
            label={AUTOMATIONS_TEXT.showSidebar}
            onClick={onShowMobileSidebar}
          >
            <PanelLeftOpen />
          </AdaptiveIconButton>
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
      <Box className="kodex-automations-pane">
        {automations.length === 0 && !isLoading ? (
          <Box className="kodex-automations-empty">
            <EmptyPanel
              icon={<Plus size={22} />}
              title={AUTOMATIONS_TEXT.emptyTitle}
              text={props.mode === "calendar" ? "Create recurring calendar prompts for a target thread." : AUTOMATIONS_TEXT.emptyText}
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
      {props.mode === "calendar" ? <AutomationEditorModal
        mode="calendar" automation={calendarEditing} targetReadOnly={props.targetReadOnly}
        fallbackThreadId={defaultTargetThreadId} onClose={() => setEditorOpen(false)}
        onCreate={props.onCreateAutomation} onUpdate={props.onUpdateAutomation} onDelete={props.onDeleteAutomation}
        onPause={async id => { await props.onPauseAutomation(id); }}
        onResume={async id => { await props.onResumeAutomation(id); }}
        opened={editorOpen} threadOptions={threadOptions} renderRuns={props.renderRuns}
      /> : <AutomationEditorModal
        automation={editingAutomation && "schedule" in editingAutomation ? editingAutomation : null}
        fallbackThreadId={defaultTargetThreadId} onClose={() => setEditorOpen(false)}
        onCreate={props.onCreateAutomation} onDelete={props.onDeleteAutomation}
        onPause={async id => setEditingAutomation(await props.onPauseAutomation(id))}
        onResume={async id => setEditingAutomation(await props.onResumeAutomation(id))}
        onUpdate={props.onUpdateAutomation} opened={editorOpen} threadOptions={threadOptions} renderRuns={props.renderRuns}
      />}
    </>
  );
}
