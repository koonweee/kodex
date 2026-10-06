import { ChevronDown } from "lucide-react";

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
        <blockquote className="kodex-user-annotation-quote" aria-label={`Assistant quote, annotation ${index + 1}`}>
          <details open>
            <summary>
              <span>{annotation.text}</span>
              <ChevronDown size={14} className="kodex-user-annotation-chevron" aria-hidden="true" />
            </summary>
          </details>
        </blockquote>
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
