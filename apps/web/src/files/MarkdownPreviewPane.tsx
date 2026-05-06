import { Box, Code, Drawer, Group, Loader, SegmentedControl, Stack, Text } from "@mantine/core";
import { FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const title = preview?.title || (preview?.path ? markdownFileName(preview.path) : "Markdown preview");
  const opened = preview !== null;

  useEffect(() => {
    setMode("preview");
  }, [preview?.path]);

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
        <Code block className="kodex-markdown-preview-source">
          {content || "Empty Markdown file"}
        </Code>
      );
    }
    return (
      <Box className="kodex-markdown-preview-rendered">
        <ReactMarkdown remarkPlugins={markdownPreviewPlugins}>{content || "_Empty Markdown file_"}</ReactMarkdown>
      </Box>
    );
  }, [content, error, loading, mode, threadId]);

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
          {preview?.path}
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

function markdownFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "Markdown preview";
}
