import { Alert, Box, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import { asyncQuestionKey } from "../composer/asyncQuestionReplies";
import { useAsyncQuestionAnswers, useAsyncQuestionReplies } from "../composer/AsyncQuestionReplyProvider";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import type { TimelineItem } from "./state";
import { LazyMarkdownContent } from "./rendererShared";
import "./asyncQuestions.css";

export function AsyncQuestionCard({ item, threadId, onImageOpen, onMarkdownOpen }: {
  item: TimelineItem;
  threadId?: string;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
}) {
  const replies = useAsyncQuestionReplies();
  const answers = useAsyncQuestionAnswers();
  return <Stack className="kodex-async-questions" gap="sm">
    {(item.asyncQuestions ?? []).map((question, index) => {
      const key = asyncQuestionKey(item, index);
      const state = replies?.states[key];
      const disabled = !replies?.enabled || !!state?.pending;
      const markdown = <LazyMarkdownContent className="kodex-assistant-markdown" text={question.title} fallbackText={question.title}
        threadId={threadId} onImageOpen={onImageOpen} onMarkdownOpen={onMarkdownOpen} />;
      if (Object.hasOwn(answers, key)) {
        return <Box component="section" aria-label={`Question ${index + 1}`} className="kodex-async-question" key={key}>
          <details className="kodex-async-question-answered">
            <summary><ChevronRight aria-hidden size={16} /><Text component="span" size="sm" fw={500}>Input requested</Text></summary>
            <Stack gap="sm" mt="sm">{markdown}<blockquote className="kodex-async-question-answer">{answers[key]}</blockquote></Stack>
          </details>
        </Box>;
      }
      return <Box component="section" aria-label={`Question ${index + 1}`} className="kodex-async-question" key={key}>
        <Text size="sm" fw={500} mb="sm">Input requested</Text>
        {markdown}
        {replies ? <>
          <Group className="kodex-async-question-choices" gap="xs" mt="md">
            {question.options.map((option, optionIndex) => <Button key={optionIndex} variant="default" disabled={disabled}
              onClick={() => { void replies.send(key, option, false); }}>{option}</Button>)}
          </Group>
          <form onSubmit={(event) => { event.preventDefault(); void replies.send(key, state?.draft ?? "", true); }}>
            <Textarea mt="sm" aria-label={`Reply to question ${index + 1}`} placeholder="Write your reply…" autosize minRows={2}
              value={state?.draft ?? ""} disabled={disabled}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (!disabled) event.currentTarget.form?.requestSubmit();
              }} onChange={(event) => replies.setDraft(key, event.currentTarget.value)} />
            <Group justify="flex-end" mt="xs"><Button type="submit" size="xs" loading={state?.pending}
              disabled={disabled || !state?.draft.trim()}>Send reply</Button></Group>
          </form>
          {state?.error ? <Alert role="alert" color="red" mt="sm">{state.error}</Alert> : null}
        </> : question.options.length ? <ul>{question.options.map((option, i) => <li key={i}>{option}</li>)}</ul> : null}
      </Box>;
    })}
  </Stack>;
}
