import { Button, CloseButton, Group, Paper, Text } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getPwaUpdateState,
  registerPwaServiceWorker,
  subscribeToPwaUpdates,
  type PwaUpdateState,
} from "./registerServiceWorker";

export function PwaLifecycle() {
  const [dismissed, setDismissed] = useState(false);
  const [updateState, setUpdateState] = useState<PwaUpdateState>(getPwaUpdateState);

  useEffect(() => {
    const unsubscribe = subscribeToPwaUpdates(setUpdateState);
    void registerPwaServiceWorker().catch(() => undefined);
    return unsubscribe;
  }, []);

  if (!updateState.needRefresh || dismissed) {
    return null;
  }

  return (
    <div className="kodex-pwa-lifecycle" role="presentation">
      <Paper className="kodex-pwa-lifecycle-notice" role="status" radius="lg">
        <Group align="center" gap="xs" wrap="nowrap">
          <RefreshCw className="kodex-pwa-lifecycle-icon" size={18} aria-hidden="true" />
          <Text className="kodex-pwa-lifecycle-copy" size="sm" fw={600}>
            Update available
          </Text>
          <Button onClick={() => void updateState.updateServiceWorker?.()} size="compact-sm" variant="light">
            Update
          </Button>
          <CloseButton aria-label="Dismiss update notice" onClick={() => setDismissed(true)} size="sm" />
        </Group>
      </Paper>
    </div>
  );
}
