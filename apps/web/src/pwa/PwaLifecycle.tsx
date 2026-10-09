import { Button, CloseButton, Group, Paper, Switch, Text } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getPwaUpdateState,
  registerPwaServiceWorker,
  subscribeToPwaUpdates,
  type PwaUpdateState,
} from "./registerServiceWorker";

import { useInterfacePreferences } from "../preferences/useInterfacePreferences";
import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { usePwaUpdateCountdown } from "./usePwaUpdateCountdown";

export function PwaLifecycle() {
  const { preferences, setAutoUpdatePwa } = useInterfacePreferences();
  const [updateState, setUpdateState] = useState<PwaUpdateState>(getPwaUpdateState);

  useEffect(() => {
    const unsubscribe = subscribeToPwaUpdates(setUpdateState);
    void registerPwaServiceWorker().catch(() => undefined);
    return unsubscribe;
  }, []);

  const { countdown, dismissed, updating, error, update, dismiss } = usePwaUpdateCountdown(updateState, preferences.autoUpdatePwa);

  if (!updateState.needRefresh || dismissed) {
    return null;
  }

  return (
    <div className="kodex-pwa-lifecycle" role="presentation">
      <Paper className="kodex-pwa-lifecycle-notice" role="status" radius="lg">
        <Group align="center" gap="xs" wrap="nowrap">
          <RefreshCw className="kodex-pwa-lifecycle-icon" size={18} aria-hidden="true" />
          <Text className="kodex-pwa-lifecycle-copy" size="sm" fw={600}>
            <AnimatedNumericText text={updating ? "Updating…" : countdown !== null ? `Updating in ${countdown}s` : "Update available"} />
          </Text>
          <Button onClick={() => void update()} disabled={updating || !updateState.updateServiceWorker} size="compact-sm" variant="light">
            Update
          </Button>
          <CloseButton aria-label="Dismiss update notice" onClick={dismiss} disabled={updating} size="sm" />
        </Group>
        <Switch className="kodex-pwa-auto-update" label="Auto-update" size="xs" checked={preferences.autoUpdatePwa} onChange={event => setAutoUpdatePwa(event.currentTarget.checked)} />
        {error ? <Text size="xs" role="alert">{error}</Text> : null}
      </Paper>
    </div>
  );
}
