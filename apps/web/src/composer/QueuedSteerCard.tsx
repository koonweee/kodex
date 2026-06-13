import { Box, Button, Text, Tooltip } from "@mantine/core";
import { X } from "lucide-react";

import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { queuedInputFileCount, queuedInputImageCount, queuedInputText, type QueuedSteerRow } from "./types";

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
        const fileCount = queuedInputFileCount(row);
        const imageCount = queuedInputImageCount(row);
        const text = queuedInputText(row);
        const previewText = text || attachmentCountLabel(imageCount, fileCount);
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
              <Tooltip label={previewText} multiline position="top-start" w="min(320px, calc(100vw - 32px))">
                <Text className="kodex-queued-steer-text" size="sm">
                  {previewText}
                </Text>
              </Tooltip>
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
            <AdaptiveIconButton
              className="kodex-queued-steer-abort"
              density="compact"
              disabled={isBusy}
              label={ABORT_BUTTON_LABEL}
              onClick={() => onAbortRow(row)}
            >
              <X />
            </AdaptiveIconButton>
          </Box>
        );
      })}
    </Box>
  );
}

function attachmentCountLabel(imageCount: number, fileCount: number): string {
  const parts = [
    imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
    fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "Queued message";
}
