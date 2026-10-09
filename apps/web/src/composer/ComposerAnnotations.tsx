import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { Box, Button, Group, Text, Textarea } from "@mantine/core";
import { ChevronDown, MessageSquareQuote, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEventHandler, type PointerEventHandler } from "react";

import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import type { ComposerDraftState } from "./useComposerDraftState";

export function ComposerAnnotations({ draftState, disabled, collapseByDefault = false, onPointerDown, onKeyDown }: {
  draftState: Pick<ComposerDraftState, "annotations" | "annotationFocusId" | "clearAnnotationFocus" | "removeAnnotation" | "updateAnnotation">;
  disabled: boolean;
  collapseByDefault?: boolean;
  onPointerDown?: PointerEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}) {
  // A deliberate toggle or annotation editing owns the disclosure until this
  // draft is empty; density changes only affect the untouched default.
  const [choice, setChoice] = useState<boolean | null>(null);
  const expanded = choice ?? !collapseByDefault;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const focusId = draftState.annotationFocusId;
  const lastId = draftState.annotations.at(-1)?.id;
  useLayoutEffect(() => {
    if (!focusId || disabled) return;
    if (!expanded) {
      setChoice(true);
      return;
    }
    commentRef.current?.focus({ preventScroll: true });
    if (document.activeElement === commentRef.current) draftState.clearAnnotationFocus();
  }, [focusId, expanded, disabled, draftState.clearAnnotationFocus]);
  useEffect(() => {
    if (!lastId) setChoice(null);
  }, [lastId]);
  useEffect(() => {
    if (expanded && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [expanded, lastId]);
  if (!draftState.annotations.length) return null;
  return (
    <Box className="kodex-composer-annotations">
      <Button type="button" variant="subtle" color="gray" size="compact-sm"
        aria-expanded={expanded} aria-controls={listId}
        leftSection={<MessageSquareQuote size={16} />} rightSection={<ChevronDown size={14} className="kodex-composer-annotation-chevron" aria-hidden="true" />}
        onClick={() => setChoice(!expanded)}>
        <AnimatedNumericText text={`${draftState.annotations.length} ${draftState.annotations.length === 1 ? "annotation" : "annotations"}`} />
      </Button>
      <Box ref={listRef} id={listId} hidden={!expanded} className="kodex-composer-annotation-list">
        {draftState.annotations.map((annotation, index) => (
          <Box key={annotation.id} className="kodex-composer-annotation">
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="xs" c="dimmed">Annotation {index + 1}</Text>
              <AdaptiveIconButton label={`Remove annotation ${index + 1}`} disabled={disabled}
                onClick={() => draftState.removeAnnotation(annotation.id)}><X /></AdaptiveIconButton>
            </Group>
            <blockquote>{annotation.text}</blockquote>
            <Textarea ref={annotation.id === focusId ? commentRef : undefined} aria-label={`Annotation ${index + 1} comment`} placeholder="Add an optional comment…"
              autosize minRows={1} maxRows={4} value={annotation.comment} disabled={disabled}
              onFocus={() => setChoice(true)} onPointerDown={disabled ? undefined : onPointerDown} onKeyDown={disabled ? undefined : onKeyDown} onChange={(event) => draftState.updateAnnotation(annotation.id, event.currentTarget.value)} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}
