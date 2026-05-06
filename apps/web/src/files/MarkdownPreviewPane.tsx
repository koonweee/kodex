import { Box, Drawer, Group, Loader, SegmentedControl, Stack, Text } from "@mantine/core";
import { FileText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { fetchThreadFilePreview } from "../api/client";
import type { MarkdownPreviewRequest } from "./types";

type MarkdownPreviewPaneProps = {
  onClose: () => void;
  preview: MarkdownPreviewRequest | null;
  threadId?: string;
};

const markdownPreviewPlugins = [remarkGfm, remarkBreaks];

export function MarkdownPreviewPane({ onClose, preview, threadId }: MarkdownPreviewPaneProps) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const title =
    preview?.title ||
    (preview?.path
      ? markdownLocationTitle(markdownFileName(preview.path), preview.line, preview.column)
      : "Markdown preview");
  const pathLabel = preview?.path ? markdownLocationTitle(preview.path, preview.line, preview.column) : "";
  const opened = preview !== null;
  const targetLineRef = useRef<HTMLDivElement | null>(null);
  const setTargetLineRef = useCallback(
    (element: HTMLDivElement | null) => {
      targetLineRef.current = element;
      if (element && mode === "source" && !loading && !error && preview?.line) {
        element.scrollIntoView({ block: "center" });
      }
    },
    [error, loading, mode, preview?.line],
  );

  useEffect(() => {
    setMode(preview?.line ? "source" : "preview");
  }, [preview?.line, preview?.path]);

  useEffect(() => {
    if (!preview || !threadId) {
      setContent("");
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchThreadFilePreview(threadId, preview.path)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("");
          setError("Unable to load Markdown preview.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [preview, threadId]);

  useEffect(() => {
    if (mode !== "source" || loading || error || !preview?.line) {
      return;
    }
    targetLineRef.current?.scrollIntoView({ block: "center" });
  }, [content, error, loading, mode, preview?.line]);

  const body = useMemo(() => {
    if (!threadId) {
      return <Text size="sm">Select a thread to preview this file.</Text>;
    }
    if (loading) {
      return (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm">Loading Markdown preview</Text>
        </Group>
      );
    }
    if (error) {
      return (
        <Text size="sm" className="kodex-ui-text" data-tone="danger">
          {error}
        </Text>
      );
    }
    if (mode === "source") {
      return (
        <MarkdownSourcePreview
          content={content}
          targetLine={preview?.line}
          setTargetLineRef={setTargetLineRef}
        />
      );
    }
    return (
      <Box className="kodex-markdown-preview-rendered">
        <ReactMarkdown remarkPlugins={markdownPreviewPlugins}>{content || "_Empty Markdown file_"}</ReactMarkdown>
      </Box>
    );
  }, [content, error, loading, mode, preview?.line, setTargetLineRef, threadId]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        <Group gap="xs" wrap="nowrap">
          <FileText size={17} aria-hidden="true" />
          <Text fw={700} size="sm">
            {title}
          </Text>
        </Group>
      }
      className="kodex-markdown-preview-pane"
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          {pathLabel}
        </Text>
        <SegmentedControl
          aria-label="Markdown preview mode"
          value={mode}
          onChange={(value) => setMode(value as "preview" | "source")}
          data={[
            { label: "Preview", value: "preview" },
            { label: "Source", value: "source" },
          ]}
        />
        {body}
      </Stack>
    </Drawer>
  );
}

function MarkdownSourcePreview({
  content,
  setTargetLineRef,
  targetLine,
}: {
  content: string;
  setTargetLineRef: (element: HTMLDivElement | null) => void;
  targetLine?: number;
}) {
  const lines = content ? content.split("\n") : ["Empty Markdown file"];
  return (
    <Box aria-label="Markdown source" className="kodex-markdown-preview-source" role="region">
      {lines.map((line, index) => {
        const lineNumber = index + 1;
        const isTarget = targetLine === lineNumber;
        return (
          <div
            className="kodex-markdown-preview-source-line"
            data-line={lineNumber}
            data-line-target={isTarget ? "true" : undefined}
            key={lineNumber}
            ref={isTarget ? setTargetLineRef : undefined}
          >
            <span aria-hidden="true" className="kodex-markdown-preview-source-line-number">
              {lineNumber}
            </span>
            <span className="kodex-markdown-preview-source-line-content">{line || " "}</span>
          </div>
        );
      })}
    </Box>
  );
}

function markdownFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "Markdown preview";
}

function markdownLocationTitle(fileName: string, line?: number, column?: number): string {
  if (!line) {
    return fileName;
  }
  return column ? `${fileName}:${line}:${column}` : `${fileName}:${line}`;
}
