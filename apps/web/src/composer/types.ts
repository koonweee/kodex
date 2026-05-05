import type { ImageUpload, QueuedInput, UserInput } from "../api/client";

export type PendingAttachment = {
  id: string;
  file: File;
  objectUrl: string;
  status: "pending" | "uploading" | "uploaded" | "error";
  uploaded?: ImageUpload;
  error?: string;
};

export type QueuedSteerRow = QueuedInput;

export function queuedInputText(row: QueuedInput): string {
  return row.input
    .map((input) => (input.type === "text" ? input.text : null))
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

export function queuedInputImageCount(row: QueuedInput): number {
  return row.input.filter(isImageInput).length;
}

function isImageInput(input: UserInput): boolean {
  return input.type === "image" || input.type === "localImage";
}
