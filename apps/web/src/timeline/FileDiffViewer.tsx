import { Box, Code, Stack } from "@mantine/core";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import type { FileData } from "react-diff-view";

type FileDiffViewerProps = {
  diff: string;
  path?: string;
};

export function FileDiffViewer({ diff, path }: FileDiffViewerProps) {
  const normalizedDiff = normalizeUnifiedDiff(diff, path);
  let files: FileData[] = [];
  try {
    files = parseDiff(normalizedDiff, { nearbySequences: "zip" });
  } catch {
    files = [];
  }

  const label = path ? `File diff for ${path}` : "File diff";
  if (files.length === 0) {
    return (
      <Box aria-label={label} className="kodex-file-diff-viewer">
        <Code block className="kodex-timeline-output">
          {diff}
        </Code>
      </Box>
    );
  }

  return (
    <Stack gap={6} aria-label={label} className="kodex-file-diff-viewer">
      {files.map((file) => (
        <Box className="kodex-file-diff-file" key={`${file.oldPath}-${file.newPath}`}>
          <Diff diffType={file.type} hunks={file.hunks} viewType="unified">
            {(hunks) => hunks.map((hunk) => <Hunk hunk={hunk} key={`${hunk.oldStart}-${hunk.newStart}-${hunk.content}`} />)}
          </Diff>
        </Box>
      ))}
    </Stack>
  );
}

function normalizeUnifiedDiff(diff: string, path = "file"): string {
  const trimmed = diff.trimStart();
  if (trimmed.startsWith("diff --git") || trimmed.startsWith("--- ")) {
    return trimmed;
  }
  const safePath = path || "file";
  return [`diff --git a/${safePath} b/${safePath}`, `--- a/${safePath}`, `+++ b/${safePath}`, trimmed].join("\n");
}
