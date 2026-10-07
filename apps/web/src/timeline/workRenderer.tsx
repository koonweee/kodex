import { Alert, Box, Text } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TimelineWorkRow } from "./reducer";

type TimelineWorkRowRendererProps = {
  children?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  row: TimelineWorkRow;
};

function TimelineWorkRowRendererImpl({
  children,
  expanded = false,
  onExpandedChange,
  row,
}: TimelineWorkRowRendererProps) {
  const elapsedMs = useWorkElapsedMs(row);
  const verb = { running: "Working", completed: "Worked", failed: "Failed", interrupted: "Stopped" }[row.state];
  const connector = row.state === "failed" || row.state === "interrupted" ? "after" : "for";
  const label = elapsedMs === null ? verb : `${verb} ${connector} ${fmtElapsedCompact(Math.floor(elapsedMs / 1_000))}`;

  if (row.state === "running") {
    return (
      <Box className="kodex-work-row" data-state="running">
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <WorkHeaderDivider />
      </Box>
    );
  }

  const failure = row.state === "failed" || (row.state === "interrupted" && row.errorMessage) ? (
    <Alert color={row.state === "failed" ? "red" : "yellow"} title={label} role="alert">
      {row.errorMessage || "The turn failed. No error details are available."}
    </Alert>
  ) : null;

  if (row.collapsedRows.length === 0) {
    return (
      <Box className="kodex-work-row" data-state={row.state}>
        {failure || <Text size="xs" c="dimmed">{label}</Text>}
        <WorkHeaderDivider />
      </Box>
    );
  }

  return (
    <>
      {failure}
      <details
        className="kodex-work-row"
        data-state={row.state}
        onToggle={(event) => onExpandedChange?.(event.currentTarget.open)}
        open={expanded}
      >
        <summary>
          <Box className="kodex-work-summary-content">
            <Text size="xs" c="dimmed">
              {label}
            </Text>
            <ChevronRight size={16} className="kodex-work-caret" aria-hidden="true" />
          </Box>
          <WorkHeaderDivider />
        </summary>
        {expanded ? children : null}
      </details>
    </>
  );
}

export const TimelineWorkRowRenderer = memo(TimelineWorkRowRendererImpl);
TimelineWorkRowRenderer.displayName = "TimelineWorkRowRenderer";

function WorkHeaderDivider() {
  return <Box aria-hidden="true" className="kodex-timeline-final-response-divider kodex-work-header-divider" />;
}

function useWorkElapsedMs(row: TimelineWorkRow): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (row.state !== "running" || row.startedAtMs === undefined) {
      return;
    }
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [row.state, row.startedAtMs]);
  if (row.startedAtMs === undefined) {
    return null;
  }
  if (row.state !== "running") {
    return Math.max(0, (row.completedAtMs ?? row.startedAtMs) - row.startedAtMs);
  }
  return Math.max(0, now - row.startedAtMs);
}

function fmtElapsedCompact(elapsedSecs: number): string {
  if (elapsedSecs < 60) {
    return `${elapsedSecs}s`;
  }
  if (elapsedSecs < 3600) {
    const minutes = Math.floor(elapsedSecs / 60);
    const seconds = elapsedSecs % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(elapsedSecs / 3600);
  const minutes = Math.floor((elapsedSecs % 3600) / 60);
  const seconds = elapsedSecs % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

