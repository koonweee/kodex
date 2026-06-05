import { Alert, Button, Group, Text } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getPwaUpdateState,
  registerPwaServiceWorker,
  subscribeToPwaUpdates,
  type PwaUpdateState,
} from "./registerServiceWorker";

export function PwaLifecycle() {
  const [updateState, setUpdateState] = useState<PwaUpdateState>(getPwaUpdateState);

  useEffect(() => {
    const unsubscribe = subscribeToPwaUpdates(setUpdateState);
    void registerPwaServiceWorker().catch(() => undefined);
    return unsubscribe;
  }, []);

  if (!updateState.needRefresh) {
    return null;
  }

  return (
    <div className="kodex-pwa-lifecycle" role="presentation">
      <Alert
        className="kodex-pwa-lifecycle-alert"
        color="blue"
        icon={<RefreshCw size={18} />}
        role="status"
        title="Update available"
        variant="light"
      >
        <Group align="center" gap="sm" justify="space-between" wrap="wrap">
          <Text className="kodex-pwa-lifecycle-copy" size="sm">
            Reload to use the latest Kodex app bundle.
          </Text>
          <Button onClick={() => void updateState.updateServiceWorker?.()} size="xs" variant="filled">
            Update
          </Button>
        </Group>
      </Alert>
    </div>
  );
}
