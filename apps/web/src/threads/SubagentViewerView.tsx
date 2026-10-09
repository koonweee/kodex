import { Alert, Badge, Box, Button, Group, Loader, Select, Stack, Text } from "@mantine/core";
import { Bot } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { ThreadSubagentSummary } from "../api/client";
import { PaneLayout } from "../shared/PaneLayout";
import { errorMessageFrom } from "../shared/values";

export type SubagentViewerEntry = Pick<ThreadSubagentSummary,
  "id" | "agentNickname" | "agentRole" | "name" | "preview" | "status" | "canAcceptDirectInput">;

export type SubagentViewerViewProps = {
  subagents: SubagentViewerEntry[];
  selectedSubagentId: string | null;
  onSelectSubagent: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  error: Error | null;
  onReload: () => void;
  isLoading: boolean;
  timelinePhase: string;
  scrollRef: Ref<HTMLDivElement>;
  children: ReactNode;
};

/** Shared main viewer chrome; native data readers belong to the caller. */
export function SubagentViewerView({ subagents, selectedSubagentId, onSelectSubagent,
  hasMore, loadingMore, onLoadMore, error, onReload, isLoading, timelinePhase,
  scrollRef, children }: SubagentViewerViewProps) {
  const selectedSubagent = subagents.find(entry => entry.id === selectedSubagentId) ?? subagents[0] ?? null;
  const selectorData = subagents.map(subagent => ({ label: subagentLabel(subagent), value: subagent.id }));
  return (
    <PaneLayout component="aside" aria-label="Subagent thread viewer" className="kodex-subagent-viewer">
      <Stack className="kodex-subagent-viewer-inner" gap="sm">
        {error ? (
          <Alert color="red" title="Subagents could not be loaded">
            {errorMessageFrom(error)}
            <Button variant="subtle" size="compact-sm" onClick={onReload}>Reload subagents</Button>
          </Alert>
        ) : null}
        {!selectedSubagent ? !error && <Text size="sm" c="dimmed">No subagents in the current native list.</Text> : <>
        <Group className="kodex-subagent-viewer-header" gap="xs" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" className="kodex-subagent-viewer-heading">
            <Bot size={16} />
            <Text fw={700} size="sm" truncate>
              {subagentLabel(selectedSubagent)}
            </Text>
          </Group>
          <Badge data-tone={statusTone(selectedSubagent.status)} size="xs" variant="light">
            {statusLabel(selectedSubagent.status)}
          </Badge>
        </Group>
        <Select
            label="Subagent"
            className="kodex-subagent-selector"
            comboboxProps={{ floatingStrategy: "fixed" }}
            data={selectorData}
            onChange={(id) => { if (id) onSelectSubagent(id); }}
            allowDeselect={false}
            searchable
            size="xs"
            value={selectedSubagent.id}
        />
        {selectedSubagent.canAcceptDirectInput === false ? (
          <Badge variant="light" size="xs">Read-only</Badge>
        ) : selectedSubagent.canAcceptDirectInput === null ? (
          <Badge variant="light" size="xs">Input capability unknown</Badge>
        ) : null}
        <Box
          className="kodex-subagent-timeline-scroll"
          data-entry-phase={timelinePhase}
          ref={scrollRef}
        >
          {isLoading ? (
            <Group className="kodex-subagent-loading" gap="xs" justify="center">
              <Loader size="sm" />
              <Text c="dimmed" size="sm">
                Loading subagent
              </Text>
            </Group>
          ) : (
            children
          )}
        </Box>
        </>}
        {hasMore ? <Button variant="subtle" size="compact-sm" onClick={onLoadMore} loading={loadingMore}>Load more subagents</Button> : null}
      </Stack>
    </PaneLayout>
  );
}

function subagentLabel(subagent: SubagentViewerEntry): string {
  if (subagent.agentNickname) {
    return subagent.agentRole
      ? `${subagent.agentNickname} [${subagent.agentRole}]`
      : subagent.agentNickname;
  }
  if (subagent.agentRole) {
    return subagent.agentRole;
  }
  return subagent.name || subagent.preview || `Agent ${subagent.id.slice(0, 8)}`;
}

function statusLabel(status: SubagentViewerEntry["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "systemError":
      return "System error";
    case "notLoaded":
      return "Not loaded";
    case "idle":
    default:
      return "Idle";
  }
}

function statusTone(status: SubagentViewerEntry["status"]): string {
  if (status === "active") {
    return "success";
  }
  if (status === "notLoaded") {
    return "muted";
  }
  return "neutral";
}
