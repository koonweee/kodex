import type { WebSearchAction } from "./state";
import { eventPayloadItem, payloadRecord, stringValue } from "./presentationShared";

export function webSearchAction(payload: unknown): WebSearchAction | null {
  const item = eventPayloadItem(payload);
  const action = payloadRecord(item.action) ?? payloadRecord(payloadRecord(payload)?.action);
  if (!action) {
    const query = stringValue(item.query) || stringValue(payloadRecord(payload)?.query);
    return query ? { kind: "search", query } : null;
  }
  const kind = (stringValue(action.type) || stringValue(action.kind) || stringValue(action.action)).toLowerCase();
  if (kind.includes("search")) {
    const query =
      stringValue(action.query) || stringValue(action.q) || stringValue(item.query) || stringValue(payloadRecord(payload)?.query);
    return query ? { kind: "search", query } : null;
  }
  if (kind.includes("open")) {
    const title = stringValue(action.title);
    const url = stringValue(action.url) || stringValue(action.uri);
    return title || url ? { kind: "open", title: title || undefined, url: url || undefined } : null;
  }
  return null;
}

export function actionLabel(action: WebSearchAction | null): string {
  if (!action) {
    return "";
  }
  if (action.kind === "search") {
    return `Searched web for "${action.query}"`;
  }
  if (action.kind === "open") {
    return `Opened page ${action.title || action.url || ""}`.trim();
  }
  return action.label;
}
