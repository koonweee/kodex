import { Box, Code, Group, Stack, Text } from "@mantine/core";
import { ChevronRight, FileDiff } from "lucide-react";
import { lazy, memo, Suspense, useState } from "react";
import type { SyntheticEvent } from "react";

import { fileChangeActionIsModified, type FileChangeEntry } from "./presentationFile";
import { payloadValue } from "./rendererShared";
import type { TimelineFileChangeEntry, TimelineItem } from "./reducer";

const FileDiffViewer = lazy(() =>
  import("./FileDiffViewer").then((module) => ({ default: module.FileDiffViewer })),
);

type TimelineFileChangesRendererProps = {
  entries: TimelineFileChangeEntry[];
  showDebug?: boolean;
};

function TimelineFileChangesRendererImpl({ entries, showDebug = false }: TimelineFileChangesRendererProps) {
  const [isOpen, setIsOpen] = useState(false);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open);
  };

  if (entries.length === 0) {
    return null;
  }
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  const fileChangeLabel = entries.length === 1 ? "1 file changed" : `${entries.length} files changed`;
  return (
    <details className="kodex-file-changes-panel" onToggle={handleToggle}>
      <Group
        component="summary"
        gap="xs"
        wrap="nowrap"
        className="kodex-file-changes-heading"
        aria-expanded={isOpen}
        aria-label={`${isOpen ? "Collapse" : "Expand"} ${fileChangeLabel}`}
      >
        <FileDiff size={15} />
        <Text size="sm" fw={700} className="kodex-file-changes-title">
          {fileChangeLabel}
        </Text>
        {additions > 0 ? (
          <Text size="sm" className="kodex-file-change-count" data-tone="success">
            +{additions}
          </Text>
        ) : null}
        {deletions > 0 ? (
          <Text size="sm" className="kodex-file-change-count" data-tone="danger">
            -{deletions}
          </Text>
        ) : null}
        <ChevronRight size={16} className="kodex-file-changes-caret" aria-hidden="true" />
      </Group>
      {isOpen ? (
        <>
          <Stack gap={0} className="kodex-file-change-table">
            {entries.map((entry) => (
              <FileChangeEntryRow entry={entry} key={entry.id} />
            ))}
          </Stack>
          {showDebug ? <Text size="xs" c="dimmed">{entries.length} canonical file change entries</Text> : null}
        </>
      ) : null}
    </details>
  );
}

export const TimelineFileChangesRenderer = memo(TimelineFileChangesRendererImpl);
TimelineFileChangesRenderer.displayName = "TimelineFileChangesRenderer";

export function FileChangeBlock({ item }: { item: TimelineItem }) {
  const path = item.path || payloadValue(item.payload, "path");
  if (item.output && fileChangeActionIsModified(item.action)) {
    return (
      <Suspense fallback={<FileDiffFallback diff={item.output} />}>
        <FileDiffViewer diff={item.output} path={path || undefined} />
      </Suspense>
    );
  }
  return (
    <Stack gap={6} className="kodex-file-change-block">
      <Text size="sm">{fileChangeItemSummary(item)}</Text>
    </Stack>
  );
}

function FileDiffFallback({ diff }: { diff: string }) {
  return (
    <Code block className="kodex-timeline-output">
      {diff}
    </Code>
  );
}

function FileChangeEntryRow({ entry }: { entry: FileChangeEntry }) {
  const isModified = fileChangeActionIsModified(entry.action);
  const [isOpen, setIsOpen] = useState(false);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open);
  };
  const summary = <FileChangeEntrySummary entry={entry} />;

  if (!isModified || !entry.diff) {
    return <Box className="kodex-file-change-row">{summary}</Box>;
  }

  return (
    <details className="kodex-file-change-row kodex-file-change-entry" onToggle={handleToggle}>
      <summary>
        {summary}
        <ChevronRight size={16} className="kodex-file-change-caret" aria-hidden="true" />
      </summary>
      {isOpen ? (
        <Box className="kodex-file-change-diff">
          <Suspense fallback={<FileDiffFallback diff={entry.diff} />}>
            <FileDiffViewer diff={entry.diff} path={entry.path} />
          </Suspense>
        </Box>
      ) : null}
    </details>
  );
}

function FileChangeEntrySummary({ entry }: { entry: FileChangeEntry }) {
  return (
    <Group gap="xs" wrap="nowrap" className="kodex-file-change-summary">
      <Text size="sm" className="kodex-file-change-action">
        {entry.action || "Modified"}
      </Text>
      <Text size="sm" className="kodex-file-change-path" title={entry.path}>
        {entry.path}
      </Text>
      {entry.additions > 0 ? (
        <Text size="sm" className="kodex-file-change-count" data-tone="success">
          +{entry.additions}
        </Text>
      ) : null}
      {entry.deletions > 0 ? (
        <Text size="sm" className="kodex-file-change-count" data-tone="danger">
          -{entry.deletions}
        </Text>
      ) : null}
    </Group>
  );
}

function fileChangeItemSummary(item: TimelineItem): string {
  const path = item.path || payloadValue(item.payload, "path");
  const action = fileChangeActionIsModified(item.action) ? "Modified" : item.action || "Modified";
  return path ? `${action} ${path}` : `${action} files`;
}
