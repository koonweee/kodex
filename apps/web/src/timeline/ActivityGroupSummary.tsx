import { Text, VisuallyHidden } from "@mantine/core";
import { ActivityCommandCount } from "./ActivityCommandCount";
import { activityGroupSummary } from "./activitySummary";
import type { TimelineItem } from "./reducer";

export function ActivityGroupSummary({ items }: { items: TimelineItem[] }) {
  const commandCount = items.filter((item) => item.kind === "command_execution").length;
  const activitySummary = activityGroupSummary(items.filter(item => item.kind !== "command_execution"));
  const prefix = commandCount
    ? activitySummary === "Worked" ? "Ran " : `${activitySummary}, ran `
    : activitySummary;
  const suffix = commandCount === 1 ? " command" : " commands";
  const summary = commandCount ? `${prefix}${commandCount}${suffix}` : prefix;
  return (
    <Text size="xs" c="var(--kodex-text-secondary)" fw={700} className="kodex-activity-group-title" title={summary}>
      {commandCount > 0 ? (
        <>
          <VisuallyHidden>{summary}</VisuallyHidden>
          <span aria-hidden="true">
            {prefix}<ActivityCommandCount value={commandCount} />{suffix}
          </span>
        </>
      ) : summary}
    </Text>
  );
}
