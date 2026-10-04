import { stripAttachmentEnvelope } from "../timeline/presentationShared";
import { asRecord } from "../shared/values";

/** Interpret only display/edit fields; retain every raw native variant for writes. */
export function editableQueueText(input: unknown[]): Array<{ index: number; text: string }> {
  return input.flatMap((value, index) => {
    const item = asRecord(value);
    return item.type === "text" && typeof item.text === "string" && !isAttachmentEnvelope(item.text) ? [{ index, text: item.text }] : [];
  });
}

export function queueInputPreview(input: unknown[]): string {
  const text = editableQueueText(input).map((item) => item.text).join("\n").trim();
  return text || input.map((item) => {
    const type = asRecord(item).type;
    return typeof type === "string" ? type : "Native input";
  }).join(", ") || "Queued message";
}

export function replaceQueueText(input: unknown[], edits: Map<number, string>): unknown[] {
  return input.map((value, index) => {
    const item = asRecord(value);
    const text = edits.get(index);
    if (item.type !== "text" || typeof item.text !== "string" || isAttachmentEnvelope(item.text) || text === undefined || text === item.text) return value;
    // Text spans belong to the original text; native skills and other variants
    // remain intact without inventing replacement spans or re-resolving names.
    return { ...item, text, text_elements: [] };
  });
}

export function restorableQueueText(input: unknown[]): string | null {
  if (input.length !== 1) return null;
  const item = asRecord(input[0]);
  if (item.type !== "text" || typeof item.text !== "string" || !item.text.trim()) return null;
  if (Object.keys(item).some((key) => !["type", "text", "text_elements"].includes(key))) return null;
  if (item.text_elements !== undefined && (!Array.isArray(item.text_elements) || item.text_elements.length > 0)) return null;
  if (item.text.includes("```kodex-attachments")) return null;
  return item.text;
}

function isAttachmentEnvelope(text: string): boolean {
  const visible = stripAttachmentEnvelope(text);
  return visible !== text && visible.trim().length === 0;
}
