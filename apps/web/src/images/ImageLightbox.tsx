import { Box } from "@mantine/core";
import { useEffect } from "react";

import type { ImageLightboxImage } from "./types";

export function ImageLightbox({
  image,
  onClose,
}: {
  image: ImageLightboxImage | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!image) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [image, onClose]);

  if (!image) {
    return null;
  }

  return (
    <Box aria-modal="true" className="kodex-image-lightbox" role="dialog">
      <button aria-label="Close image preview" className="kodex-image-lightbox-backdrop" type="button" onClick={onClose}>
        <img alt={image.alt ?? ""} className="kodex-image-lightbox-img" src={image.src} title={image.title} />
      </button>
    </Box>
  );
}
