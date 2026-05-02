import { Box } from "@mantine/core";
import type { ReactNode } from "react";

import type { ImageLightboxImage } from "./types";

export function ImageThumbnail({
  alt = "",
  className,
  overlay,
  src,
  title,
  onOpen,
}: {
  alt?: string;
  className?: string;
  overlay?: ReactNode;
  src: string;
  title?: string;
  onOpen?: (image: ImageLightboxImage) => void;
}) {
  const content = <img alt={alt} src={src} title={title} />;
  return (
    <Box className={["kodex-image-thumbnail", className].filter(Boolean).join(" ")}>
      {onOpen ? (
        <button
          aria-label={title ? `Open ${title}` : "Open image"}
          className="kodex-image-thumbnail-button"
          type="button"
          onClick={() => onOpen({ alt, src, title })}
        >
          {content}
        </button>
      ) : (
        content
      )}
      {overlay}
    </Box>
  );
}
