import { Box, Tabs, Textarea } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export function PromptMarkdownEditor({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  const isCompact = useMediaQuery("(max-width: 760px)");
  const textarea = (
    <Textarea
      aria-label="Automation prompt"
      autosize={false}
      className="kodex-automation-prompt-textarea"
      minRows={10}
      onChange={(event) => onChange(event.currentTarget.value)}
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
    <Box className="kodex-automation-prompt-editor">
      {isCompact ? (
        <Tabs defaultValue="write" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="write">Write</Tabs.Tab>
            <Tabs.Tab value="preview">Preview</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="write">{textarea}</Tabs.Panel>
          <Tabs.Panel value="preview">{preview}</Tabs.Panel>
        </Tabs>
      ) : (
        <div className="kodex-automation-prompt-split">
          <Box className="kodex-automation-prompt-pane" data-pane="write">
            {textarea}
          </Box>
          <Box className="kodex-automation-prompt-pane" data-pane="preview">
            {preview}
          </Box>
        </div>
      )}
    </Box>
  );
}
