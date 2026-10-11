import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";

import { DeviceCodeLoginDialog } from "../account/DeviceCodeLoginDialog";
import { useAccountSession } from "../account/useAccountSession";
import { useDeviceCodeLogin } from "../account/useDeviceCodeLogin";
import { useExecutorRuntimeAvailable } from "../api/GatewayClientContext";

export function AccountPreferencesPanel() {
  const [error, setError] = useState<string | null>(null);
  const available = useExecutorRuntimeAvailable();
  const { account, handleLogout } = useAccountSession({
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Account operation failed."),
  });
  const login = useDeviceCodeLogin(account);
  const signedIn = account?.account ?? null;

  return <Stack className="kodex-preferences-panel" gap="md">
    <Text className="kodex-preferences-panel-title" fw={650}>Account</Text>
    {error ? <Alert color="red">{error}</Alert> : null}
    {signedIn ? <>
      <Text size="sm">Signed in{signedIn.email ? ` as ${signedIn.email}` : ""}.</Text>
      <Group><Button disabled={!available} onClick={handleLogout} size="xs" variant="default">Sign out</Button></Group>
    </> : <>
      <Text c="dimmed" size="sm">Sign in on this executor. Credentials stay on that machine.</Text>
      <Group><Button disabled={!available} onClick={login.start} size="xs">Sign in with ChatGPT</Button></Group>
    </>}
    <DeviceCodeLoginDialog flow={login} />
  </Stack>;
}
