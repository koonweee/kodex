import { Box, Tabs, Textarea } from "@mantine/core";
import { useState } from "react";

import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { PaneLayout, usePaneLayout } from "../shared/PaneLayout";

export function PromptMarkdownEditor({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  return <PaneLayout className="kodex-automation-prompt-editor"><PromptMarkdownEditorContent onChange={onChange} value={value} /></PaneLayout>;
}

function PromptMarkdownEditorContent({ onChange, value }: {
  onChange: (value: string) => void;
  value: string;
}) {
  const { compact } = usePaneLayout();
  const [selectedTab, setSelectedTab] = useState<string | null>("write");
  const textarea = (
    <Textarea
      aria-label="Automation prompt"
      autosize={false}
      className="kodex-automation-prompt-textarea"
      minRows={10}
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={() => setSelectedTab("write")}
      value={value}
    />
  );
  const preview = (
    <Box className="kodex-automation-prompt-preview">
      {value.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{value}</ReactMarkdown>
      ) : (
        <span className="kodex-automation-prompt-preview-empty">Nothing to preview</span>
      )}
    </Box>
  );

  return (
    <Tabs value={selectedTab} onChange={setSelectedTab} keepMounted>
      <Tabs.List style={!compact ? { display: "none" } : undefined}>
        <Tabs.Tab value="write">Write</Tabs.Tab>
        <Tabs.Tab value="preview">Preview</Tabs.Tab>
      </Tabs.List>
      <div className={`kodex-automation-prompt-panels${!compact ? " kodex-automation-prompt-split" : ""}`}>
        <Tabs.Panel value="write" className="kodex-automation-prompt-pane" data-pane="write"
          style={!compact ? { display: "block" } : undefined}>
          {textarea}
        </Tabs.Panel>
        <Tabs.Panel value="preview" className="kodex-automation-prompt-pane" data-pane="preview"
          style={!compact ? { display: "block" } : undefined}>
          {preview}
        </Tabs.Panel>
      </div>
    </Tabs>
  );
}
