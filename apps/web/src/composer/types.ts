import type { ImageUpload, TimelineFileAttachment } from "../api/client";

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
