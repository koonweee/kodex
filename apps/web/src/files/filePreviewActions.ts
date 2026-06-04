import { filePreviewUrl, type TimelineFileAttachment } from "../api/client";
import type { MarkdownPreviewRequest } from "./types";

export type FilePreviewAction =
  | { kind: "markdown"; request: MarkdownPreviewRequest }
  | { kind: "pdf"; href: string }
  | { kind: "download"; href: string; fileName: string };

export type FilePreviewTarget = {
  column?: number;
  fileName?: string;
  fragment?: string;
  line?: number;
  path: string;
  title?: string;
};

export function filePreviewAction(threadId: string, attachment: TimelineFileAttachment): FilePreviewAction {
  return filePreviewActionForTarget(threadId, {
    fileName: attachment.fileName,
    path: attachment.relativePath,
    title: attachment.fileName,
  });
}

export function filePreviewActionForTarget(threadId: string, target: FilePreviewTarget): FilePreviewAction {
  const href = `${filePreviewUrl(threadId, target.path)}${target.fragment ?? ""}`;
  const fileName = target.fileName || fileNameFromPath(target.path) || "download";
  const extension = fileExtensionFromName(fileName);
  if (extension === "md" || extension === "markdown") {
    return {
      kind: "markdown",
      request: {
        column: target.column,
        fragment: target.fragment,
        href,
        line: target.line,
        path: target.path,
        title: target.title ?? fileName,
      },
    };
  }
  if (extension === "pdf") {
    return { kind: "pdf", href };
  }
  return { kind: "download", fileName, href };
}

export function fileExtension(attachment: TimelineFileAttachment): string {
  const extension = attachment.extension || extensionFromFileName(attachment.fileName);
  return extension.replace(/^\./, "").toLocaleLowerCase();
}

export function fileExtensionFromName(fileName: string): string {
  return extensionFromFileName(fileName).replace(/^\./, "").toLocaleLowerCase();
}

export function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function extensionFromFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dotIndex + 1);
}
