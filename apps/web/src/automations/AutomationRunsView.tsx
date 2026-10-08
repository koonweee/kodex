import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { formatAutomationDate } from './schedule';

export type AutomationRunPresentation = {
  id: string;
  label: string;
  color: 'yellow' | 'red' | 'gray';
  createdAt: string;
  error?: string | null;
  detail?: string;
};

export function AutomationRunsView({ rows, error, isLoading, onRefresh, note }: {
  rows?: AutomationRunPresentation[];
  error: string | null;
  isLoading: boolean;
  onRefresh: () => void;
  note?: string;
}) {
  return <Stack gap="sm" mah={280} style={{ overflowY: 'auto' }} role="region" aria-label="Automation runs">
    <Group justify="space-between"><Text fw={600}>Recent runs</Text><Button size="compact-sm" variant="subtle" onClick={onRefresh}>Refresh runs</Button></Group>
    {note ? <Text size="xs" c="dimmed">{note}</Text> : null}
    {error ? <Alert color="red">{error}</Alert> : null}
    {isLoading ? <Text size="sm">Loading runs…</Text> : null}
    {rows?.length === 0 ? <Text size="sm" c="dimmed">No runs recorded.</Text> : null}
    {rows?.map(run => <Stack key={run.id} gap={4}>
      <Group gap="xs"><Badge variant="light" color={run.color}>{run.label}</Badge><Text size="xs" c="dimmed">{formatAutomationDate(run.createdAt)}</Text></Group>
      {run.error ? <Text size="sm">{run.error}</Text> : null}
      {run.detail ? <Text size="xs">{run.detail}</Text> : null}
    </Stack>)}
  </Stack>;
}
