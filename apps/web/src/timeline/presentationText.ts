import { contentArrayText, eventPayloadItem, payloadRecord, summarizeValue, textValue } from "./presentationShared";

export function payloadText(payload: unknown): string {
  const record = payloadRecord(payload);
  if (!record) {
    return "";
  }

  for (const key of ["delta", "text", "message", "content"]) {
    const value = textValue(record[key]);
    if (value) {
      return value;
    }
  }

  const item = payloadRecord(record.item);
  if (item) {
    for (const key of ["text", "message", "content"]) {
      const value = textValue(item[key]);
      if (value) {
        return value;
      }
    }
    const contentText = contentArrayText(item.content);
    if (contentText) {
      return contentText;
    }
  }

  const contentText = contentArrayText(record.content);
  if (contentText) {
    return contentText;
  }

  return "";
}

export function reasoningSummary(payload: unknown): string {
  const item = eventPayloadItem(payload);
  for (const key of ["summary", "text", "content"]) {
    const value = textValue(item[key]);
    if (value) {
      return value;
    }
  }
  const contentText = contentArrayText(item.content);
  if (contentText) {
    return contentText;
  }
  const summary = item.summary ?? payloadRecord(payload)?.summary;
  if (Array.isArray(summary)) {
    return summary.map((value) => (typeof value === "string" ? value : summarizeValue(value))).filter(Boolean).join("\n");
  }
  return "";
}
