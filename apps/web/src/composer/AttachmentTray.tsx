import { ActionIcon, Box, Tooltip } from "@mantine/core";
import { X } from "lucide-react";

import type { PendingAttachment } from "./types";

export function AttachmentTray({
  attachments,
  compact = false,
  onRemove,
}: {
  attachments: PendingAttachment[];
  compact?: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <Box className="kodex-attachment-tray" data-compact={compact ? "true" : "false"}>
      {attachments.map((attachment) => (
        <Tooltip label={attachment.file.name} key={attachment.id}>
          <Box className="kodex-attachment-thumb">
            <img src={attachment.objectUrl} alt="" />
            {attachment.status === "uploading" ? <Box className="kodex-attachment-status">Uploading</Box> : null}
            {attachment.status === "error" ? <Box className="kodex-attachment-status">Failed</Box> : null}
            {!compact ? (
              <ActionIcon
                aria-label={`Remove ${attachment.file.name}`}
                className="kodex-attachment-remove"
                size="xs"
                type="button"
                variant="filled"
                onClick={() => onRemove(attachment.id)}
              >
                <X size={12} />
              </ActionIcon>
            ) : null}
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}
