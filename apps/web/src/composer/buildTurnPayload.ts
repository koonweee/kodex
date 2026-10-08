import {
  uploadFiles,
  uploadImages,
  type ImageUpload,
  type TextElement,
  type TimelineFileAttachment,
  type UserInput,
} from "../api/client";
import { errorMessageFrom } from "../shared/values";
import type { PendingAttachment } from "./types";

export type ComposerUploads = {
  images: (threadId: string, files: File[]) => Promise<ImageUpload[]>;
  files: (threadId: string, files: File[]) => Promise<TimelineFileAttachment[]>;
};
type TurnPayloadOptions = {
  uploads?: ComposerUploads;
  threadId: string;
  text: string;
  attachments: PendingAttachment[];
  skillInputs: UserInput[];
  skillTextElements: TextElement[];
  updateAttachments: (updates: Map<string, Partial<PendingAttachment>>) => void;
  rememberImagePreviewUrls: (previewUrls: Record<string, string>) => void;
};

export async function buildTurnPayload({
  uploads: uploadCommands,
  threadId,
  text,
  attachments,
  skillInputs,
  skillTextElements,
  updateAttachments,
  rememberImagePreviewUrls,
}: TurnPayloadOptions): Promise<{ input: UserInput[]; attachments: TimelineFileAttachment[]; images: ImageUpload[] }> {
  const input: UserInput[] = [];
  const fileAttachments: TimelineFileAttachment[] = [];
  const images: ImageUpload[] = [];
  if (text) {
    input.push({ type: "text", text, ...(skillTextElements.length > 0 ? { text_elements: skillTextElements } : {}) });
  }
  input.push(...skillInputs);
  if (attachments.length > 0) {
    const imageAttachmentsToUpload = attachments.filter(
      (attachment) => attachment.kind === "image" && !attachment.uploaded,
    );
    const fileAttachmentsToUpload = attachments.filter(
      (attachment) => attachment.kind === "file" && !attachment.uploadedFile,
    );
    const attachmentsToUpload = [...imageAttachmentsToUpload, ...fileAttachmentsToUpload];
    updateAttachments(
      new Map(
        attachmentsToUpload.map((attachment) => [
          attachment.id,
          { status: "uploading" as const, error: undefined },
        ]),
      ),
    );
    let uploads: ImageUpload[] = [];
    let fileUploads: TimelineFileAttachment[] = [];
    try {
      uploads =
        imageAttachmentsToUpload.length > 0
          ? await (uploadCommands ? uploadCommands.images(threadId, imageAttachmentsToUpload.map((attachment) => attachment.file)) : uploadImages(imageAttachmentsToUpload.map((attachment) => attachment.file)))
          : [];
      fileUploads =
        fileAttachmentsToUpload.length > 0
          ? await (uploadCommands?.files ?? uploadFiles)(threadId, fileAttachmentsToUpload.map((attachment) => attachment.file))
          : [];
      if (uploads.length !== imageAttachmentsToUpload.length || fileUploads.length !== fileAttachmentsToUpload.length) {
        throw new Error("Gateway upload response did not match selected attachments");
      }
    } catch (error) {
      const message = errorMessageFrom(error);
      updateAttachments(
        new Map(
          attachmentsToUpload.map((attachment) => [
            attachment.id,
            { status: "error" as const, error: message },
          ]),
        ),
      );
      throw error;
    }

    const previewUrls: Record<string, string> = {};
    const uploadedByAttachmentId = new Map<string, ImageUpload>();
    const uploadedFileByAttachmentId = new Map<string, TimelineFileAttachment>();
    for (const [index, upload] of uploads.entries()) {
      const attachment = imageAttachmentsToUpload[index];
      if (attachment) {
        uploadedByAttachmentId.set(attachment.id, upload);
        if (attachment.objectUrl) {
          previewUrls[upload.path] = attachment.objectUrl;
        }
      }
    }
    for (const [index, upload] of fileUploads.entries()) {
      const attachment = fileAttachmentsToUpload[index];
      if (attachment) {
        uploadedFileByAttachmentId.set(attachment.id, upload);
      }
    }
    updateAttachments(
      new Map(
        attachmentsToUpload.map((attachment) => [
          attachment.id,
          {
            status: "uploaded" as const,
            uploaded: uploadedByAttachmentId.get(attachment.id),
            uploadedFile: uploadedFileByAttachmentId.get(attachment.id),
            error: undefined,
          },
        ]),
      ),
    );
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        const upload = attachment.uploaded ?? uploadedByAttachmentId.get(attachment.id);
        if (upload) {
          input.push({ type: "localImage", path: upload.path });
          images.push(upload);
        }
      } else {
        const upload = attachment.uploadedFile ?? uploadedFileByAttachmentId.get(attachment.id);
        if (upload) {
          fileAttachments.push(upload);
        }
      }
    }
    if (Object.keys(previewUrls).length > 0) {
      rememberImagePreviewUrls(previewUrls);
    }
  }
  return { input, attachments: fileAttachments, images };
}
