import { Box, Stack, Text } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { filePreviewUrl } from "../api/client";
import type { ImageLightboxImage } from "../images/types";
import { displayableImageSrc, localPreviewPath } from "./rendererShared";
import type { TimelineItem } from "./reducer";

export function ImageActivityBlock({
  item,
  onImageOpen,
  threadId,
}: {
  item: TimelineItem;
  onImageOpen?: (image: ImageLightboxImage) => void;
  threadId?: string;
}) {
  const directSrc = displayableImageSrc(item.imageSrc) ?? displayableImageSrc(item.path);
  const previewPath = localPreviewPath(item.path) ?? localPreviewPath(item.imageSrc);
  const src = directSrc ?? (threadId && previewPath ? filePreviewUrl(threadId, previewPath) : null);
  const title = item.imageSrc ? item.path || item.text : item.path;
  const metadata = imageActivityMetadata(item);
  return (
    <Stack gap={4}>
      {src ? (
        <Box className="kodex-activity-image-preview">
          <ImageActivityThumbnail src={src} title={title} onImageOpen={onImageOpen} />
        </Box>
      ) : (
        <ImagePreviewUnavailable
          path={item.path ? undefined : previewPath ?? undefined}
          title={item.text || "Image activity"}
        />
      )}
      {item.kind === "image_generation" ? (
        <ImageActivityDetails metadata={metadata} />
      ) : (
        <ImageActivityInlineMetadata metadata={metadata} />
      )}
    </Stack>
  );
}

function imageActivityMetadata(item: TimelineItem): Array<{ label: string; value: string }> {
  return [
    item.path ? { label: "Path", value: item.path } : null,
    item.resultSummary ? { label: "Prompt", value: item.resultSummary } : null,
    item.output ? { label: "Result", value: item.output } : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null);
}

function ImageActivityInlineMetadata({ metadata }: { metadata: Array<{ label: string; value: string }> }) {
  if (metadata.length === 0) {
    return null;
  }
  return (
    <>
      {metadata.map((entry) => (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row" key={entry.label}>
          {entry.label}: {entry.value}
        </Text>
      ))}
    </>
  );
}

function ImageActivityDetails({ metadata }: { metadata: Array<{ label: string; value: string }> }) {
  if (metadata.length === 0) {
    return null;
  }
  return (
    <details className="kodex-image-activity-details">
      <summary>
        <Text size="xs" c="dimmed">
          Details
        </Text>
        <ChevronRight size={14} className="kodex-image-activity-details-caret" aria-hidden="true" />
      </summary>
      <Stack gap={4} mt={4}>
        {metadata.map((entry) => (
          <Text size="xs" c="dimmed" className="kodex-timeline-inline-row" key={entry.label}>
            {entry.label}: {entry.value}
          </Text>
        ))}
      </Stack>
    </details>
  );
}

function ImageActivityThumbnail({
  onImageOpen,
  src,
  title,
}: {
  onImageOpen?: (image: ImageLightboxImage) => void;
  src: string;
  title?: string;
}) {
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
  }, [src]);

  if (loadFailed) {
    return <ImagePreviewUnavailable title="Preview unavailable" />;
  }

  const content = <img alt="" src={src} title={title} onError={() => setLoadFailed(true)} />;
  return (
    <Box className="kodex-image-thumbnail">
      {onImageOpen ? (
        <button
          aria-label={title ? `Open ${title}` : "Open image"}
          className="kodex-image-thumbnail-button"
          type="button"
          onClick={() => onImageOpen({ alt: "", src, title })}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </Box>
  );
}

function ImagePreviewUnavailable({ path, title }: { path?: string; title: string }) {
  return (
    <Stack gap={2} className="kodex-activity-image-unavailable">
      <Text size="sm">{title}</Text>
      {path ? (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          {path}
        </Text>
      ) : null}
    </Stack>
  );
}
