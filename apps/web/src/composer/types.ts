import type { ImageUpload } from "../api/client";

export type PendingAttachment = {
  id: string;
  file: File;
  objectUrl: string;
  status: "pending" | "uploading" | "uploaded" | "error";
  uploaded?: ImageUpload;
  error?: string;
};

export type QueuedSteerRow = {
  id: string;
  text: string;
  attachments: PendingAttachment[];
  autoStartFailed?: boolean;
  isSubmitting?: boolean;
};
