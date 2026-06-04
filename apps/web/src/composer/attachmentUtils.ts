import type { UserInput } from "../api/client";
import type { TimelineImage } from "../timeline/reducer";
import type { PendingAttachment } from "./types";

export function hasFiles(dataTransfer: DataTransfer) {
  return filesFromDataTransfer(dataTransfer).length > 0;
}

export function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const items = Array.from(dataTransfer.items);
  if (items.length > 0) {
    const itemFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => (typeof item.getAsFile === "function" ? item.getAsFile() : null))
      .filter((file): file is File => file !== null);
    if (itemFiles.length > 0) {
      return itemFiles;
    }
  }
  return Array.from(dataTransfer.files);
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
  const images: TimelineImage[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.objectUrl) {
      images.push({ url: attachment.objectUrl });
    }
  }
  return images;
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
