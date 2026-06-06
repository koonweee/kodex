import { Box, Text, Tooltip } from "@mantine/core";
import { X } from "lucide-react";

import { ImageThumbnail } from "../images/ImageThumbnail";
import type { ImageLightboxImage } from "../images/types";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import type { PendingAttachment } from "./types";

export function AttachmentTray({
  attachments,
  compact = false,
  onRemove,
  onImageOpen,
}: {
  attachments: PendingAttachment[];
  compact?: boolean;
  onRemove: (id: string) => void;
  onImageOpen?: (image: ImageLightboxImage) => void;
}) {
  return (
    <Box className="kodex-attachment-tray" data-compact={compact ? "true" : "false"}>
      {attachments.map((attachment) => (
        <Tooltip label={attachment.file.name} key={attachment.id}>
          <Box className="kodex-attachment-thumb">
            {attachment.kind === "image" && attachment.objectUrl ? (
              <ImageThumbnail
                alt=""
                src={attachment.objectUrl}
                title={attachment.file.name}
                onOpen={onImageOpen}
              />
            ) : (
              <Box className="kodex-file-attachment-tile">
                <Text className="kodex-file-attachment-extension">{fileExtensionLabel(attachment.file.name)}</Text>
                <Text className="kodex-file-attachment-name">{attachment.file.name}</Text>
              </Box>
            )}
            {attachment.status === "uploading" ? <Box className="kodex-attachment-status">Uploading</Box> : null}
            {attachment.status === "error" ? <Box className="kodex-attachment-status">Failed</Box> : null}
            <AdaptiveIconButton
              className="kodex-attachment-remove"
              density="compact"
              label={`Remove ${attachment.file.name}`}
              onClick={() => onRemove(attachment.id)}
              tooltip={false}
              variant="filled"
            >
              <X />
            </AdaptiveIconButton>
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}

function fileExtensionLabel(fileName: string): string {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? extension.slice(0, 5).toUpperCase() : "FILE";
}
