import { payloadRecord, stringValue, uniqueValues } from "./presentationShared";

export type FileChangeEntry = {
  action: string;
  additions: number;
  deletions: number;
  diff: string;
  itemId?: string;
  path: string;
};

export function fileChangeSummary(value: unknown): { action: string; diff: string; path: string } {
  const entries = fileChangeEntries(value);
  const actions = entries.map((entry) => entry.action);
  const diffs = entries.filter((entry) => fileChangeActionIsModified(entry.action)).map((entry) => entry.diff).filter(Boolean);
  const paths = entries.map((entry) => entry.path);
  return {
    action: uniqueValues(actions).join(", "),
    diff: diffs.join("\n"),
    path: uniqueValues(paths).join(", "),
  };
}

export function fileChangeEntries(value: unknown): FileChangeEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: FileChangeEntry[] = [];
  for (const valueItem of value) {
    const change = payloadRecord(valueItem);
    if (!change) {
      continue;
    }
    const action = fileChangeActionLabel(change.kind);
    const diff = stringValue(change.diff);
    const path = stringValue(change.path);
    if (!path && !action) {
      continue;
    }
    const counts = diffLineCounts(diff);
    entries.push({
      action,
      additions: counts.additions,
      deletions: counts.deletions,
      diff,
      path,
    });
  }
  return entries;
}

export function fileChangeEntriesFromTimelineItem(item: {
  action?: string;
  id?: string;
  output?: string;
  path?: string;
  payload?: unknown;
}): FileChangeEntry[] {
  const payload = payloadRecord(item.payload);
  const payloadItem = payloadRecord(payload?.item) ?? payload;
  const structuredEntries = fileChangeEntries(payloadItem?.changes).map((entry) => ({
    ...entry,
    itemId: item.id,
  }));
  if (structuredEntries.length > 0) {
    return structuredEntries;
  }
  const action = fileChangeActionLabel(item.action);
  const diff = stringValue(item.output);
  const path = stringValue(item.path) || stringValue(payloadItem?.path);
  if (!path && !action) {
    return [];
  }
  const counts = diffLineCounts(diff);
  return [
    {
      action,
      additions: counts.additions,
      deletions: counts.deletions,
      diff,
      itemId: item.id,
      path,
    },
  ];
}

export function fileChangeActionLabel(value: unknown): string {
  return uniqueValues(fileChangeActionParts(value).map(fileChangeActionPartLabel).filter(Boolean)).join(", ");
}

export function fileChangeActionIsModified(value: unknown): boolean {
  return fileChangeActionParts(value).some((part) => fileChangeActionPartLabel(part) === "Modified");
}

function fileChangeActionParts(value: unknown): string[] {
  const kind = fileChangeKind(value);
  return kind
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function fileChangeKind(value: unknown): string {
  const record = payloadRecord(value);
  return stringValue(record?.type) || stringValue(value);
}

function fileChangeActionPartLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "add" || normalized === "added") {
    return "Added";
  }
  if (normalized === "delete" || normalized === "deleted" || normalized === "remove" || normalized === "removed") {
    return "Deleted";
  }
  if (normalized === "update" || normalized === "modify" || normalized === "modified") {
    return "Modified";
  }
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "";
}

function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}
