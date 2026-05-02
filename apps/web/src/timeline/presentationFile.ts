import { payloadRecord, stringValue, uniqueValues } from "./presentationShared";

export function fileChangeSummary(value: unknown): { action: string; diff: string; path: string } {
  if (!Array.isArray(value)) {
    return { action: "", diff: "", path: "" };
  }
  const actions: string[] = [];
  const diffs: string[] = [];
  const paths: string[] = [];
  for (const valueItem of value) {
    const change = payloadRecord(valueItem);
    if (!change) {
      continue;
    }
    const action = fileChangeKind(change.kind);
    const diff = stringValue(change.diff);
    const path = stringValue(change.path);
    if (action) {
      actions.push(action);
    }
    if (diff) {
      diffs.push(diff);
    }
    if (path) {
      paths.push(path);
    }
  }
  return {
    action: uniqueValues(actions).join(", "),
    diff: diffs.join("\n"),
    path: uniqueValues(paths).join(", "),
  };
}

function fileChangeKind(value: unknown): string {
  const record = payloadRecord(value);
  return stringValue(record?.type) || stringValue(value);
}
