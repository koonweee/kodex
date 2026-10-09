import { Button, Code, Group, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { SettingsMenu } from '../account/SettingsMenu';
import { formatUsageLimitLines } from '../account/rateLimits';
import type { useNativeAccount } from './useNativeAccount';

export function NativeAccountMenu({ state, onSelectAutomations, onOpenPreferences, onShowDebugEventsChange, showDebugEvents, onShowCommandOutputsChange, showCommandOutputs = false }: {
  state: ReturnType<typeof useNativeAccount>; onSelectAutomations: () => void; onOpenPreferences: () => void;
  onShowDebugEventsChange: (value: boolean) => void; showDebugEvents: boolean;
  onShowCommandOutputsChange?: (value: boolean) => void; showCommandOutputs?: boolean;
}) {
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => { if (state.snapshot?.authenticated) setLoginOpen(false); }, [state.snapshot?.authenticated]);
  return <>
    <SettingsMenu accountLabel={state.snapshot?.account?.label ?? null} isAuthenticated={state.snapshot?.authenticated ?? false}
      onLogin={() => setLoginOpen(true)} onLogout={state.logout} logoutPending={state.logoutPending}
      onSelectAutomations={onSelectAutomations} onOpenPreferences={onOpenPreferences}
      onShowDebugEventsChange={onShowDebugEventsChange} showDebugEvents={showDebugEvents}
      onShowCommandOutputsChange={onShowCommandOutputsChange} showCommandOutputs={showCommandOutputs}
      usageLimitLines={formatUsageLimitLines(state.usage)} />
    <Modal opened={loginOpen} onClose={() => setLoginOpen(false)} title="Sign in with ChatGPT" size="sm" closeButtonProps={{ 'aria-label': 'Close sign-in guidance' }}>
      <Stack>
        <Text>Sign in on the gateway machine using this instance’s dedicated profile.</Text>
        <Code block>{'npm run login -- login --mode device --profile "/absolute/path/to/instance-profile"'}</Code>
        <Text size="sm">Run the command from spikes/mastra-code-sdk. Replace the example profile path with the same profile path used to start this gateway instance.</Text>
        <Group justify="flex-end"><Button variant="default" onClick={() => setLoginOpen(false)}>Close</Button></Group>
      </Stack>
    </Modal>
  </>;
}
