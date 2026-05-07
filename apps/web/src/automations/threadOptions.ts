import type { ThreadSummary } from "../api/client";
import { threadDisplayTitle } from "../threads/helpers";

export type AutomationThreadOption = {
  label: string;
  value: string;
};

export function automationThreadOptions({
  chatThreads,
  pinnedThreads,
  projectThreads,
}: {
  chatThreads: ThreadSummary[];
  pinnedThreads: ThreadSummary[];
  projectThreads: ThreadSummary[];
}): AutomationThreadOption[] {
  const seen = new Set<string>();
  const options: AutomationThreadOption[] = [];
  for (const thread of [...pinnedThreads, ...projectThreads, ...chatThreads]) {
    if (seen.has(thread.id)) {
      continue;
    }
    seen.add(thread.id);
    options.push({ label: threadDisplayTitle(thread), value: thread.id });
  }
  return options;
}

export function threadLabelById(options: AutomationThreadOption[], threadId: string): string {
  return options.find((option) => option.value === threadId)?.label ?? "Unknown thread";
}
