import { Box, Button, Group } from "@mantine/core";
import { AlertCircle, X } from "lucide-react";

import { AdaptiveIconButton } from "../../ui/AdaptiveIconButton";
import { EmptyPanel } from "../../ui/EmptyPanel";
import { useWorkspace } from "../../workspace/WorkspaceProvider";

export function ThreadUnavailablePane({ paneId, onBrowseThreads }: {
  paneId: string;
  onBrowseThreads: () => void;
}) {
  const { closePane } = useWorkspace();
  return (
    <Box className="kodex-thread-empty kodex-thread-column">
      <EmptyPanel
        icon={<AlertCircle size={22} />}
        title="Thread not found or unavailable"
        text="This thread could not be loaded. It may have been archived, deleted, or unavailable from this gateway."
      />
      <Group className="kodex-thread-empty-actions" justify="center" gap="xs" wrap="nowrap">
        <Button
          className="kodex-thread-empty-action"
          onClick={onBrowseThreads}
          size="compact-sm"
          type="button"
          variant="light"
        >
          Browse threads
        </Button>
        <AdaptiveIconButton label="Close pane" onClick={() => closePane(paneId, null)}>
          <X />
        </AdaptiveIconButton>
      </Group>
    </Box>
  );
}

