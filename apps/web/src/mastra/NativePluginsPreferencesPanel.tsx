import { Badge, Box, Group, Stack, Text } from '@mantine/core';
import { Package } from 'lucide-react';

export function NativePluginsPreferencesPanel() {
  return <Stack className="kodex-preferences-panel" gap={14}>
    <Text className="kodex-preferences-panel-title" fw={650}>Plugins</Text>
    <Box className="kodex-plugin-row">
      <Box aria-hidden="true" className="kodex-plugin-icon"><Package size={18} /></Box>
      <Stack className="kodex-plugin-copy" gap={5}>
        <Group gap={8} wrap="wrap">
          <Text fw={650} size="sm">Kodex Control</Text>
          <Badge data-tone="neutral" size="sm" variant="light">Built in</Badge>
        </Group>
        <Text c="dimmed" size="xs">
          Available in ordinary chats to discover projects, read and manage chats, and manage automations.
        </Text>
        <Text c="dimmed" size="xs">
          These tools are included with Kodex. No plugin installation or MCP server setup is needed.
        </Text>
      </Stack>
    </Box>
  </Stack>;
}
