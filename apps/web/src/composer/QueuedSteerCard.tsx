import { ActionIcon, Box, Button, Text, Tooltip } from "@mantine/core";
import { X } from "lucide-react";

import { AttachmentTray } from "./AttachmentTray";
import type { QueuedSteerRow } from "./types";

const QUEUE_LABEL = "Queued steer messages";
const QUEUE_ROW_LABEL = "Queued steer message";
const STEER_BUTTON_LABEL = "Steer";
const RETRY_BUTTON_LABEL = "Retry";
const ABORT_BUTTON_LABEL = "Abort queued message";

export function QueuedSteerCard({
  blockIdleStartActions,
  hasActiveTurn,
  onAbortRow,
  onSubmitRow,
  rows,
}: {
  blockIdleStartActions: boolean;
  hasActiveTurn: boolean;
  onAbortRow: (row: QueuedSteerRow) => void;
  onSubmitRow: (row: QueuedSteerRow) => void;
  rows: QueuedSteerRow[];
}) {
  const visibleRows = rows.filter((row) => !row.isSubmitting);
  if (visibleRows.length === 0) {
    return null;
  }

  return (
    <Box aria-label={QUEUE_LABEL} className="kodex-queued-steer" role="region">
      {visibleRows.map((row) => {
        const submitLabel = row.autoStartFailed && !hasActiveTurn ? RETRY_BUTTON_LABEL : STEER_BUTTON_LABEL;
        const shouldShowSubmitAction = hasActiveTurn || !blockIdleStartActions;
        return (
          <Box
            aria-label={QUEUE_ROW_LABEL}
            className="kodex-queued-steer-row"
            data-steer-row-id={row.id}
            key={row.id}
            role="group"
          >
            <Box className="kodex-queued-steer-content">
              {row.attachments.length > 0 ? (
                <AttachmentTray attachments={row.attachments} compact onRemove={() => undefined} />
              ) : null}
              <Text className="kodex-queued-steer-text" size="sm">
                {row.text || `${row.attachments.length} image${row.attachments.length === 1 ? "" : "s"}`}
              </Text>
            </Box>
            {shouldShowSubmitAction ? (
              <Button className="kodex-queued-steer-button" size="xs" onClick={() => onSubmitRow(row)}>
                {submitLabel}
              </Button>
            ) : null}
            <Tooltip label={ABORT_BUTTON_LABEL}>
              <ActionIcon
                aria-label={ABORT_BUTTON_LABEL}
                className="kodex-queued-steer-abort"
                size="sm"
                type="button"
                variant="subtle"
                onClick={() => onAbortRow(row)}
              >
                <X size={14} />
              </ActionIcon>
            </Tooltip>
          </Box>
        );
      })}
    </Box>
  );
}
