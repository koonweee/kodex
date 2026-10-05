export type DraftAnnotation = {
  id: string;
  text: string;
  comment: string;
};

export function appendResponseAnnotations(text: string, annotations: DraftAnnotation[]): string {
  if (annotations.length === 0) return text;
  const block = [
    "<response_annotations>",
    ...annotations.flatMap((annotation, index) => [
      `<annotation${index + 1}>`,
      `Assistant text: ${quoteAnnotationText(annotation.text)}`,
      ...(annotation.comment.length > 0 ? [`User annotation: ${quoteAnnotationText(annotation.comment)}`] : []),
      `</annotation${index + 1}>`,
    ]),
    "</response_annotations>",
  ].join("\n");
  return text ? `${text}\n\n${block}` : block;
}

function quoteAnnotationText(text: string): string {
  return JSON.stringify(text).replace(/[<>&]/g, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    return "\\u0026";
  });
}
