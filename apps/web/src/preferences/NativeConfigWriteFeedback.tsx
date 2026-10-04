import { Alert, Stack, Text } from "@mantine/core";
import type { McpReloadResponse, NativeConfigWriteResult } from "../api/client";

export function NativeConfigWriteFeedback({ write, reload, notificationError }: { write: NativeConfigWriteResult; reload?: McpReloadResponse; notificationError?: string | null }) {
  const overridden = write.status === "okOverridden";
  return <Alert color={overridden || reload?.error || notificationError ? "yellow" : "green"} variant="light">
    <Stack gap={4}>
      <Text size="sm">Saved to {write.filePath}.</Text>
      {overridden ? <Text size="sm">Another native configuration layer overrides this saved value. The controls show the effective configuration.</Text> : null}
      {notificationError ? <Text size="sm">{notificationError}</Text> : null}
      {reload?.error ? <Text size="sm">Saved, but MCP reload was not confirmed: {reload.error}</Text> : null}
      {reload?.queued ? <Text size="sm">MCP reload requested. Server status updates determine availability.</Text> : null}
    </Stack>
  </Alert>;
}
