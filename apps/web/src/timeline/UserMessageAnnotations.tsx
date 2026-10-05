import { ChevronDown, Quote } from "lucide-react";

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
        <details className="kodex-user-annotation-quote" open>
          <summary aria-label={`Quoted from assistant, annotation ${index + 1}`}>
            <Quote size={14} aria-hidden="true" />
            <span>Quoted from assistant</span>
            <ChevronDown size={14} className="kodex-user-annotation-chevron" aria-hidden="true" />
          </summary>
          <blockquote>{annotation.text}</blockquote>
        </details>
        {annotation.comment ? <div className="kodex-user-annotation-comment">{annotation.comment}</div> : null}
      </div>
    ))}
  </div>;
}

export function annotationMessageCopyText(message: AnnotationMessage): string {
  const annotations = message.annotations.map(({ text, comment }) => {
    const quote = text.split("\n").map((line) => `> ${line}`).join("\n");
    return comment ? `${quote}\n\n${comment}` : quote;
  });
  return [...(message.text ? [message.text] : []), ...annotations].join("\n\n");
}
