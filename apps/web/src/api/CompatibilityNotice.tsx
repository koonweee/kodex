import { Alert, Button, Stack, Text } from "@mantine/core";
import { useState, useSyncExternalStore } from "react";
import { getPwaUpdateState, getServiceWorkerRegistration, pwaGatewayIsSameOrigin } from "../pwa/registerServiceWorker";
import { compatibilityRequired, subscribeCompatibility } from "./compatibility";

/** Keep the workspace mounted: drafts and attachments must survive discovering a stale client. */
export function CompatibilityNotice() {
  const required = useSyncExternalStore(subscribeCompatibility, compatibilityRequired);
  const [error, setError] = useState<string | null>(null);
  if (!required) return null;
  async function update() {
    try {
      if (pwaGatewayIsSameOrigin() && "serviceWorker" in navigator && await navigator.serviceWorker.getRegistration()) {
        const registration = await getServiceWorkerRegistration();
        await registration.update();
        const state = getPwaUpdateState();
        if (!state.needRefresh || !state.updateServiceWorker) {
          setError("The update is still downloading. Try again shortly.");
          return;
        }
        await state.updateServiceWorker();
      } else {
        window.location.reload();
      }
    } catch {
      setError("Unable to download the update. Try again when connected.");
    }
  }
  return <Alert color="orange" variant="filled" role="alert" title="Update Kodex to continue" style={{ position: "fixed", top: "env(safe-area-inset-top, 0px)", left: 0, right: 0, zIndex: 1000 }}>
    <Stack gap="xs">
      <Text size="sm">The server API changed. Changes are blocked; your open drafts remain here. Copy any unsent work before reloading.</Text>
      {error ? <Text size="sm">{error}</Text> : null}
      <Button onClick={() => void update()}>Reload after saving drafts</Button>
    </Stack>
  </Alert>;
}
