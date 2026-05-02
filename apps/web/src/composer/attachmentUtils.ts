import type { UserInput } from "../api/client";
import type { TimelineImage } from "../timeline/reducer";
import type { PendingAttachment } from "./types";

export function hasImageFiles(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items);
  if (items.length > 0) {
    return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
  }
  return Array.from(dataTransfer.files).some((file) => file.type.startsWith("image/"));
}

export function createObjectUrl(file: File) {
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
}

export function revokeObjectUrl(objectUrl: string) {
  if (objectUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(objectUrl);
  }
}

export function attachmentPreviewImages(attachments: PendingAttachment[]): TimelineImage[] {
  return attachments.map((attachment) => ({ url: attachment.objectUrl }));
}

export function userInputImages(input: UserInput[]): TimelineImage[] {
  const images: TimelineImage[] = [];
  for (const item of input) {
    if (item.type === "localImage") {
      images.push({ path: item.path });
    }
    if (item.type === "image") {
      images.push({ url: item.url });
    }
  }
  return images;
}
