import { Badge, Group, Stack, Text } from '@mantine/core';

export function NativeExecutionPreferencesPanel() {
  return <Stack className="kodex-preferences-panel kodex-execution-panel" gap={14}>
    <Group justify="space-between" wrap="nowrap">
      <Text className="kodex-preferences-panel-title" fw={650}>Execution</Text>
      <Badge data-tone="neutral">Defaults</Badge>
    </Group>
    <Stack className="kodex-preferences-setting" gap={10}>
      <Text fw={600} size="sm">Permission scope</Text>
      <Text c="dimmed" size="sm">Runs on the gateway machine without a sandbox.</Text>
    </Stack>
    <Stack className="kodex-preferences-setting" gap={10}>
      <Text fw={600} size="sm">Tool approvals</Text>
      <Text c="dimmed" size="sm">Ordinary tools run without per-action approval.</Text>
    </Stack>
  </Stack>;
}
