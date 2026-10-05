export function parseResponseAnnotations(text: string): {
  text: string;
  annotations: Array<{ text: string; comment: string }>;
} | null {
  const opener = "<response_annotations>\n";
  if (!text.endsWith("\n</response_annotations>")) return null;
  const start = text.lastIndexOf(opener);
  if (start < 0 || (start > 0 && text.slice(start - 2, start) !== "\n\n")) return null;

  // Remove only the separator added by appendResponseAnnotations: skill offsets
  // and any whitespace belonging to the original message must stay unchanged.
  const mainText = start === 0 ? "" : text.slice(0, start - 2);
  if (hasUnclosedCodeFence(mainText)) return null;

  const lines = text.slice(start + opener.length, -"\n</response_annotations>".length).split("\n");
  const annotations: Array<{ text: string; comment: string }> = [];
  let line = 0;
  while (line < lines.length) {
    const number = annotations.length + 1;
    if (lines[line++] !== `<annotation${number}>`) return null;
    const quotedText = parseQuotedField(lines[line++], "Assistant text: ");
    if (quotedText === null) return null;
    let comment = "";
    if (lines[line]?.startsWith("User annotation: ")) {
      const parsedComment = parseQuotedField(lines[line++], "User annotation: ");
      if (parsedComment === null) return null;
      comment = parsedComment;
    }
    if (lines[line++] !== `</annotation${number}>`) return null;
    annotations.push({ text: quotedText, comment });
  }
  return annotations.length > 0 ? { text: mainText, annotations } : null;
}

function parseQuotedField(line: string | undefined, prefix: string): string | null {
  if (!line?.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function hasUnclosedCodeFence(text: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1][0];
    if (fence) {
      if (marker === fence.marker && match[1].length >= fence.length && match[2].trim() === "") {
        fence = null;
      }
    } else if (marker !== "`" || !match[2].includes("`")) {
      fence = { marker, length: match[1].length };
    }
  }
  return fence !== null;
}
