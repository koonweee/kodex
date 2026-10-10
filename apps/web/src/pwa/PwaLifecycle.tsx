import { ActionIcon, Button, CloseButton, Group, Paper, Popover, Text } from "@mantine/core";
import { Info, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  applyLatestFrontendUpdate,
  getPwaUpdateState,
  registerPwaServiceWorker,
  subscribeToPwaUpdates,
  type PwaUpdateState,
} from "./registerServiceWorker";

import { useInterfacePreferences } from "../preferences/useInterfacePreferences";
import { compatibilityRequired, subscribeCompatibility } from "../api/compatibility";
import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { usePwaUpdateCountdown } from "./usePwaUpdateCountdown";

export function PwaLifecycle({ hasComposerTextDraft = false }: { hasComposerTextDraft?: boolean }) {
  const { preferences } = useInterfacePreferences();
  const [updateState, setUpdateState] = useState<PwaUpdateState>(getPwaUpdateState);
  const updateRequired = useSyncExternalStore(subscribeCompatibility, compatibilityRequired);

  useEffect(() => {
    const unsubscribe = subscribeToPwaUpdates(setUpdateState);
    void registerPwaServiceWorker().catch(() => undefined);
    return unsubscribe;
  }, []);

  const { countdown, dismissed, updating, error, update, dismiss } = usePwaUpdateCountdown(
    updateState,
    preferences.autoUpdatePwa,
    {
      autoUpdateBlocked: hasComposerTextDraft,
      required: updateRequired,
      updateAction: applyLatestFrontendUpdate,
    },
  );

  if ((!updateState.needRefresh && !updateRequired) || (dismissed && !updateRequired)) {
    return null;
  }

  const label = updating
    ? "Updating…"
    : error
      ? "Update failed"
      : countdown !== null
        ? `Updating in ${countdown}s`
        : updateRequired
          ? "Update required"
          : "Update available";
  const details = error ?? (updateRequired
    ? "The server API changed. Changes are blocked until you update. Copy any unsent drafts before updating."
    : null);

  return (
    <div className="kodex-pwa-lifecycle" role="presentation">
      <Paper className="kodex-pwa-lifecycle-notice" role="status" radius="lg">
        <Group align="center" gap="xs" wrap="nowrap">
          <RefreshCw className="kodex-pwa-lifecycle-icon" size={18} aria-hidden="true" />
          <Text className="kodex-pwa-lifecycle-copy" size="sm" fw={600}>
            <AnimatedNumericText text={label} />
          </Text>
          {details ? <UpdateDetails details={details} /> : null}
          <Button onClick={() => void update()} disabled={updating} size="compact-sm" variant="light">
            Update
          </Button>
          {!updateRequired ? <CloseButton aria-label="Dismiss update notice" onClick={dismiss} disabled={updating} size="sm" /> : null}
        </Group>
      </Paper>
    </div>
  );
}

function UpdateDetails({ details }: { details: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover onChange={setOpened} opened={opened} position="bottom" withArrow>
      <Popover.Target>
        <ActionIcon
          aria-expanded={opened}
          aria-label="Update details"
          className="kodex-pwa-lifecycle-info"
          onBlur={() => setOpened(false)}
          onClick={() => setOpened(true)}
          onFocus={() => setOpened(true)}
          onMouseEnter={() => setOpened(true)}
          onMouseLeave={() => setOpened(false)}
          size="sm"
          variant="subtle"
        >
          <Info aria-hidden="true" size={15} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown maw={320} role="tooltip">
        <Text size="xs">{details}</Text>
      </Popover.Dropdown>
    </Popover>
  );
}
