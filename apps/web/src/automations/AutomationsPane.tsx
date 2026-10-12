import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { Alert, Badge, Box, Button, Group, Loader, Paper, Table, Text, Title, Tooltip } from "@mantine/core";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { PanelLeftOpen, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Automation, AutomationCreateRequest, AutomationUpdateRequest } from "../api/client";
import { ExecutorRuntimeBoundary } from "../api/GatewayClientContext";
import { ExecutorPickerDialog, type ExecutorChoice } from "../federation/ExecutorPickerDialog";
import { useFederatedCatalogContext } from "../federation/FederatedCatalogContext";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { EmptyPanel } from "../ui/EmptyPanel";
import { AutomationEditorModal } from "./AutomationEditorModal";
import {
  FederatedAutomationsController,
  type FederatedAutomationRow,
} from "./FederatedAutomationsController";
import { formatAutomationDate, formatAutomationInterval } from "./schedule";
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

type LocalAutomationsPaneProps = {
  automations: Automation[];
  defaultThreadId: string | null;
  executorId?: string;
  isLoading: boolean;
  onCreateAutomation: (request: AutomationCreateRequest) => Promise<Automation>;
  onDeleteAutomation: (automationId: string) => Promise<void>;
  onPauseAutomation: (automationId: string) => Promise<Automation>;
  onResumeAutomation: (automationId: string) => Promise<Automation>;
  onShowMobileSidebar: () => void;
  onUpdateAutomation: (automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
  preferredExecutorId?: string | null;
  threadOptions: AutomationThreadOption[];
};

type AutomationRow = FederatedAutomationRow & { threadOptions: AutomationThreadOption[] };
type AutomationSourceError = { executorId: string; executorName: string; message: string };

export function AutomationsPane(props: LocalAutomationsPaneProps) {
  const federation = useFederatedCatalogContext();
  if (federation) {
    return <FederatedAutomationsPane onShowMobileSidebar={props.onShowMobileSidebar} preferredExecutorId={props.preferredExecutorId ?? props.executorId ?? null} />;
  }
  return <LocalAutomationsPane {...props} />;
}

function LocalAutomationsPane(props: LocalAutomationsPaneProps) {
  const executorId = props.executorId ?? "local";
  const rows = useMemo<AutomationRow[]>(() => props.automations.map((automation) => ({
    automation,
    available: true,
    executorId,
    executorName: "",
    instanceId: "local",
    key: automation.id,
    threadOptions: props.threadOptions,
  })), [executorId, props.automations, props.threadOptions]);
  return <AutomationsPaneView
    defaultExecutorId={executorId}
    executorChoices={[{ id: executorId, name: executorId }]}
    isLoading={props.isLoading}
    instanceIdsByExecutor={{ [executorId]: "local" }}
    onCreateAutomation={(_executorId, _instanceId, request) => props.onCreateAutomation(request)}
    onDeleteAutomation={(_executorId, _instanceId, automationId) => props.onDeleteAutomation(automationId)}
    onPauseAutomation={(_executorId, _instanceId, automationId) => props.onPauseAutomation(automationId)}
    onResumeAutomation={(_executorId, _instanceId, automationId) => props.onResumeAutomation(automationId)}
    onShowMobileSidebar={props.onShowMobileSidebar}
    onUpdateAutomation={(_executorId, _instanceId, automationId, request) => props.onUpdateAutomation(automationId, request)}
    rows={rows}
    showExecutorColumn={false}
    sourceErrors={[]}
    threadOptionsByExecutor={{ [executorId]: props.threadOptions }}
    defaultThreadIdByExecutor={{ [executorId]: props.defaultThreadId }}
  />;
}

function FederatedAutomationsPane({ onShowMobileSidebar, preferredExecutorId }: {
  onShowMobileSidebar: () => void;
  preferredExecutorId: string | null;
}) {
  return <FederatedAutomationsController active preferredExecutorId={preferredExecutorId}>
    {(value) => <AutomationsPaneView
      defaultExecutorId={value.preferredExecutorId}
      executorChoices={value.executorChoices}
      instanceIdsByExecutor={value.instanceIdsByExecutor}
      isLoading={value.isLoading}
      onCreateAutomation={value.createAutomation}
      onDeleteAutomation={value.deleteAutomation}
      onPauseAutomation={value.pauseAutomation}
      onResumeAutomation={value.resumeAutomation}
      onShowMobileSidebar={onShowMobileSidebar}
      onUpdateAutomation={value.updateAutomation}
      rows={value.rows.map((row) => ({ ...row, threadOptions: value.threadOptionsByExecutor[row.executorId] ?? [] }))}
      showExecutorColumn
      sourceErrors={value.sourceErrors}
      threadOptionsByExecutor={value.threadOptionsByExecutor}
      defaultThreadIdByExecutor={{}}
    />}
  </FederatedAutomationsController>;
}

function AutomationsPaneView({
  defaultExecutorId,
  defaultThreadIdByExecutor,
  executorChoices,
  instanceIdsByExecutor,
  isLoading,
  onCreateAutomation,
  onDeleteAutomation,
  onPauseAutomation,
  onResumeAutomation,
  onShowMobileSidebar,
  onUpdateAutomation,
  rows,
  showExecutorColumn,
  sourceErrors,
  threadOptionsByExecutor,
}: {
  defaultExecutorId: string | null;
  defaultThreadIdByExecutor: Record<string, string | null>;
  executorChoices: ExecutorChoice[];
  instanceIdsByExecutor: Record<string, string>;
  isLoading: boolean;
  onCreateAutomation: (executorId: string, instanceId: string, request: AutomationCreateRequest) => Promise<Automation>;
  onDeleteAutomation: (executorId: string, instanceId: string, automationId: string) => Promise<void>;
  onPauseAutomation: (executorId: string, instanceId: string, automationId: string) => Promise<Automation>;
  onResumeAutomation: (executorId: string, instanceId: string, automationId: string) => Promise<Automation>;
  onShowMobileSidebar: () => void;
  onUpdateAutomation: (executorId: string, instanceId: string, automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
  rows: AutomationRow[];
  showExecutorColumn: boolean;
  sourceErrors: AutomationSourceError[];
  threadOptionsByExecutor: Record<string, AutomationThreadOption[]>;
}) {
  const [editingRow, setEditingRow] = useState<AutomationRow | null>(null);
  const [editorExecutorId, setEditorExecutorId] = useState<string | null>(null);
  const [editorInstanceId, setEditorInstanceId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const editorThreadOptions = editorExecutorId ? threadOptionsByExecutor[editorExecutorId] ?? [] : [];
  const defaultTargetThreadId = editorExecutorId
    ? defaultThreadIdByExecutor[editorExecutorId] ?? editorThreadOptions[0]?.value ?? null
    : null;
  const editorOwnerCurrent = Boolean(
    editorExecutorId && editorInstanceId && instanceIdsByExecutor[editorExecutorId] === editorInstanceId,
  );
  const editorAvailable = editorOwnerCurrent && executorChoices.some((choice) => choice.id === editorExecutorId);
  useEffect(() => {
    if (!editorOpen || editorOwnerCurrent) return;
    setEditorOpen(false);
    setEditingRow(null);
    setEditorExecutorId(null);
    setEditorInstanceId(null);
  }, [editorOpen, editorOwnerCurrent]);
  const columns = useMemo<ColumnDef<AutomationRow>[]>(() => {
    const result: ColumnDef<AutomationRow>[] = [
      {
        accessorFn: (row) => row.automation.name,
        header: "Name",
        id: "name",
        size: 220,
        cell: ({ row }) => <Box>
          <Text fw={500} size="sm">{row.original.automation.name}</Text>
          <Box className="kodex-automation-mobile-meta">
            {showExecutorColumn ? <Text c="dimmed" size="xs">{row.original.executorName}{row.original.available ? "" : " · Offline"}</Text> : null}
            <Text c="dimmed" size="xs">
              {row.original.automation.newThread ? "New chat each run" : threadLabelById(row.original.threadOptions, row.original.automation.targetThreadId ?? "")}
            </Text>
            <Group gap="xs" mt={6} wrap="wrap">
              <Badge data-tone={row.original.automation.status === "active" ? "success" : "neutral"} variant="light">{row.original.automation.status}</Badge>
              <Text c="dimmed" size="xs">{formatAutomationInterval(row.original.automation)}</Text>
              <Text c="dimmed" size="xs">Next: {formatAutomationDate(row.original.automation.nextRunAt)}</Text>
            </Group>
          </Box>
        </Box>,
      },
    ];
    if (showExecutorColumn) result.push({
      accessorFn: (row) => row.executorName,
      header: "Executor",
      id: "executor",
      size: 150,
      cell: ({ row }) => <Group gap={6} wrap="nowrap"><Text size="sm">{row.original.executorName}</Text>{row.original.available ? null : <Badge variant="light">Offline</Badge>}</Group>,
    });
    result.push(
      {
        accessorFn: (row) => row.automation.newThread ? "New chat each run" : threadLabelById(row.threadOptions, row.automation.targetThreadId ?? ""),
        header: "Target thread", id: "targetThread", size: 220,
      },
      {
        accessorFn: (row) => row.automation.status,
        header: "Status", id: "status", size: 110,
        cell: ({ row }) => <Badge data-tone={row.original.automation.status === "active" ? "success" : "neutral"} variant="light">{row.original.automation.status}</Badge>,
      },
      { accessorFn: (row) => formatAutomationDate(row.automation.nextRunAt), header: "Next run", id: "nextRunAt", size: 180 },
      { accessorFn: (row) => formatAutomationInterval(row.automation), header: "Repeat", id: "repeat", size: 120 },
      { accessorFn: (row) => formatAutomationDate(row.automation.lastRunAt), header: "Last run", id: "lastRunAt", size: 180 },
      {
        accessorFn: (row) => row.automation.lastError ?? String(row.automation.consecutiveFailureCount),
        header: "Failures", id: "failures", size: 170,
        cell: ({ row }) => row.original.automation.lastError
          ? <Text className="kodex-ui-text" data-tone="danger" lineClamp={1} size="xs">{row.original.automation.lastError}</Text>
          : <Text c="dimmed" size="sm"><AnimatedNumericText text={String(row.original.automation.consecutiveFailureCount)} /></Text>,
      },
    );
    return result;
  }, [showExecutorColumn]);
  const table = useReactTable({
    columns,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  });

  function openNewAutomation(executorId: string) {
    const instanceId = instanceIdsByExecutor[executorId];
    if (!instanceId) return;
    setPickerOpen(false);
    setEditingRow(null);
    setEditorExecutorId(executorId);
    setEditorInstanceId(instanceId);
    setEditorOpen(true);
  }
  function handleAdd() {
    if (executorChoices.length === 1) openNewAutomation(executorChoices[0]!.id);
    else setPickerOpen(true);
  }
  function handleEdit(row: AutomationRow) {
    setEditingRow(row);
    setEditorExecutorId(row.executorId);
    setEditorInstanceId(row.instanceId);
    setEditorOpen(true);
  }

  return <>
    <Group justify="space-between" wrap="nowrap" className="kodex-thread-header kodex-automations-header">
      <Group gap="xs" wrap="nowrap" className="kodex-thread-heading">
        <AdaptiveIconButton className="kodex-automations-sidebar-button" label={AUTOMATIONS_TEXT.showSidebar} onClick={onShowMobileSidebar}><PanelLeftOpen /></AdaptiveIconButton>
        <Title className="kodex-thread-title" order={3} size="h5">{AUTOMATIONS_TEXT.title}</Title>
      </Group>
      <Tooltip label={AUTOMATIONS_TEXT.add}>
        <Button aria-label={AUTOMATIONS_TEXT.add} className="kodex-automations-add-button" disabled={executorChoices.length === 0}
          leftSection={<Plus size={15} />} onClick={handleAdd} size="sm" type="button" variant="subtle">{AUTOMATIONS_TEXT.addShort}</Button>
      </Tooltip>
    </Group>
    <Box className="kodex-automations-pane">
      {sourceErrors.map((error) => <Alert color="red" key={error.executorId} mb="sm">Could not load automations from {error.executorName}. {error.message}</Alert>)}
      {rows.length === 0 && !isLoading ? <Box className="kodex-automations-empty"><EmptyPanel icon={<Plus size={22} />} title={AUTOMATIONS_TEXT.emptyTitle} text={AUTOMATIONS_TEXT.emptyText} /></Box> : (
        <Paper className="kodex-mantine-paper-root kodex-automation-table-paper"><Box className="kodex-automation-table-container">
          <Table highlightOnHover stickyHeader>
            <Table.Thead>{table.getHeaderGroups().map((group) => <Table.Tr key={group.id}>{group.headers.map((header) => {
              const direction = header.column.getIsSorted();
              return <Table.Th key={header.id} style={{ width: header.getSize() }}><button className="kodex-automation-sort-button" disabled={!header.column.getCanSort()} onClick={header.column.getToggleSortingHandler()} type="button"><span>{flexRender(header.column.columnDef.header, header.getContext())}</span>{direction ? <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span> : null}</button></Table.Th>;
            })}</Table.Tr>)}</Table.Thead>
            <Table.Tbody>{isLoading && rows.length === 0 ? <Table.Tr><Table.Td colSpan={columns.length}><Group justify="center" py="xl"><Loader size="sm" /></Group></Table.Td></Table.Tr> : table.getRowModel().rows.map((row) => (
              <Table.Tr className="kodex-automation-table-row" key={row.id} onClick={() => handleEdit(row.original)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleEdit(row.original); }
              }} tabIndex={0}>{row.getVisibleCells().map((cell) => <Table.Td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Td>)}</Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Box></Paper>
      )}
    </Box>
    <ExecutorPickerDialog choices={executorChoices} kind="automation" onClose={() => setPickerOpen(false)} onConfirm={openNewAutomation}
      opened={pickerOpen} preferredExecutorId={defaultExecutorId} />
    {editorExecutorId && editorInstanceId && editorOwnerCurrent ? <ExecutorRuntimeBoundary executorId={editorExecutorId} preserveChildrenWhenUnavailable showChildrenWhenUnavailable>
      <AutomationEditorModal
        automation={editingRow?.automation ?? null}
        disabled={!editorAvailable}
        fallbackThreadId={defaultTargetThreadId}
        onClose={() => setEditorOpen(false)}
        onCreate={(request) => onCreateAutomation(editorExecutorId, editorInstanceId, request)}
        onDelete={(automationId) => onDeleteAutomation(editorExecutorId, editorInstanceId, automationId)}
        onPause={async (automationId) => {
          const automation = await onPauseAutomation(editorExecutorId, editorInstanceId, automationId);
          setEditingRow((current) => current ? { ...current, automation } : current);
        }}
        onResume={async (automationId) => {
          const automation = await onResumeAutomation(editorExecutorId, editorInstanceId, automationId);
          setEditingRow((current) => current ? { ...current, automation } : current);
        }}
        onUpdate={(automationId, request) => onUpdateAutomation(editorExecutorId, editorInstanceId, automationId, request)}
        opened={editorOpen}
        threadOptions={editorThreadOptions}
      />
    </ExecutorRuntimeBoundary> : null}
  </>;
}
