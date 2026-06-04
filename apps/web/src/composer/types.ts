import type { ImageUpload, QueuedInput, TimelineFileAttachment, UserInput } from "../api/client";

export type PendingAttachment = {
  id: string;
  file: File;
  kind: "image" | "file";
  objectUrl?: string;
  status: "pending" | "uploading" | "uploaded" | "error";
  uploaded?: ImageUpload;
  uploadedFile?: TimelineFileAttachment;
  error?: string;
};

export type QueuedSteerRow = QueuedInput;

export function queuedInputText(row: QueuedInput): string {
  return stripAttachmentEnvelope(row.input
    .map((input) => (input.type === "text" ? input.text : null))
    .filter((text): text is string => Boolean(text))
    .join("\n"));
}

export function queuedInputImageCount(row: QueuedInput): number {
  return row.input.filter(isImageInput).length;
}

export function queuedInputFileCount(row: QueuedInput): number {
  return row.attachments?.length ?? 0;
}

function isImageInput(input: UserInput): boolean {
  return input.type === "image" || input.type === "localImage";
}

function stripAttachmentEnvelope(text: string): string {
  const trimmed = text.trimEnd();
  const start = trimmed.lastIndexOf("```kodex-attachments\n");
  if (start === -1 || !trimmed.endsWith("\n```")) {
    return text;
  }
  return trimmed.slice(0, start).trimEnd();
}
