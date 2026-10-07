import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { InlineSkillMentionText } from "./InlineSkillMentionText";
import type { TimelineItem } from "./reducer";
import type { parseResponseAnnotations } from "./responseAnnotations";

type AnnotationMessage = NonNullable<ReturnType<typeof parseResponseAnnotations>>;

export function UserMessageAnnotations({ message, skillMentions }: {
  message: AnnotationMessage;
  skillMentions?: TimelineItem["skillMentions"];
}) {
  return <div className="kodex-user-annotations">
    {message.text ? <div className="kodex-user-annotation-main">
      <InlineSkillMentionText text={message.text} skillMentions={skillMentions} />
    </div> : null}
    {message.annotations.map((annotation, index) => (
      <div className="kodex-user-annotation" role="group" aria-label={`Annotation ${index + 1}`} key={index}>
        <AnnotationQuote text={annotation.text} index={index} />
        {annotation.comment ? <div className="kodex-user-annotation-comment">{annotation.comment}</div> : null}
      </div>
    ))}
  </div>;
}

function AnnotationQuote({ text, index }: { text: string; index: number }) {
  const quoteRef = useRef<HTMLQuoteElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [expandable, setExpandable] = useState(false);

  useLayoutEffect(() => {
    const quote = quoteRef.current;
    if (!quote) return;
    const measure = () => {
      const preview = textRef.current;
      if (!preview) return;
      // Measure the single-line preview even while the native disclosure is open.
      // Include the caret's lane so its own width cannot make a fitting quote expandable.
      const caret = preview.nextElementSibling;
      const caretWidth = caret ? caret.getBoundingClientRect().width + (parseFloat(getComputedStyle(preview.parentElement!).columnGap) || 0) : 0;
      const whiteSpace = preview.style.whiteSpace;
      preview.style.whiteSpace = "nowrap";
      const overflows = preview.scrollWidth > preview.clientWidth + caretWidth;
      preview.style.whiteSpace = whiteSpace;
      setExpandable(overflows || /[\r\n]/.test(text));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(quote);
    if (textRef.current) observer.observe(textRef.current);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [text, expandable]);

  const content = <span ref={textRef}>{text}</span>;
  return <blockquote className="kodex-user-annotation-quote" aria-label={`Assistant quote, annotation ${index + 1}`} ref={quoteRef}>
    {expandable ? <details>
      <summary className="kodex-user-annotation-quote-body">
        {content}
        <ChevronDown size={14} className="kodex-user-annotation-chevron" aria-hidden="true" />
      </summary>
    </details> : <div className="kodex-user-annotation-quote-body">{content}</div>}
  </blockquote>;
}

export function annotationMessageCopyText(message: AnnotationMessage): string {
  const annotations = message.annotations.map(({ text, comment }) => {
    const quote = text.split("\n").map((line) => `> ${line}`).join("\n");
    return comment ? `${quote}\n\n${comment}` : quote;
  });
  return [...(message.text ? [message.text] : []), ...annotations].join("\n\n");
}
