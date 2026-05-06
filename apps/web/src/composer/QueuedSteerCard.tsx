import { ActionIcon, Box, Button, Text, Tooltip } from "@mantine/core";
import { X } from "lucide-react";

import { queuedInputImageCount, queuedInputText, type QueuedSteerRow } from "./types";

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
  const visibleRows = rows;
  if (visibleRows.length === 0) {
    return null;
  }

  return (
    <Box aria-label={QUEUE_LABEL} className="kodex-queued-steer" role="region">
      {visibleRows.map((row) => {
        const isPendingCommit = row.status === "pendingCommit";
        const isBusy = row.status === "submitting" || row.status === "steering" || isPendingCommit;
        const imageCount = queuedInputImageCount(row);
        const text = queuedInputText(row);
        const submitLabel = row.status === "failed" ? RETRY_BUTTON_LABEL : STEER_BUTTON_LABEL;
        const shouldShowSubmitAction =
          !isPendingCommit && (row.status === "failed" || (hasActiveTurn && !blockIdleStartActions));
        return (
          <Box
            aria-label={QUEUE_ROW_LABEL}
            className="kodex-queued-steer-row"
            data-steer-row-id={row.id}
            key={row.id}
            role="group"
          >
            <Box className="kodex-queued-steer-content">
              <Text className="kodex-queued-steer-text" size="sm">
                {text || `${imageCount} image${imageCount === 1 ? "" : "s"}`}
              </Text>
              {row.lastError ? (
                <Text c="var(--kodex-color-danger-text)" size="xs">
                  {row.lastError}
                </Text>
              ) : null}
              {isPendingCommit ? (
                <Text c="var(--kodex-text-muted)" size="xs">
                  Steering...
                </Text>
              ) : null}
            </Box>
            {shouldShowSubmitAction ? (
              <Button
                className="kodex-queued-steer-button"
                disabled={isBusy}
                size="xs"
                onClick={() => onSubmitRow(row)}
              >
                {submitLabel}
              </Button>
            ) : null}
            <Tooltip label={ABORT_BUTTON_LABEL}>
              <ActionIcon
                aria-label={ABORT_BUTTON_LABEL}
                className="kodex-queued-steer-abort"
                disabled={isBusy}
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
