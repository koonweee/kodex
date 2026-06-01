export type ComposerTriggerToken<TTrigger extends string = string> = {
  end: number;
  query: string;
  start: number;
  trigger: TTrigger;
};

export function activeSlashCommandToken(text: string, cursor: number): ComposerTriggerToken<"/"> | null {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  let start = boundedCursor - 1;
  while (start >= 0 && isSlashCommandChar(text[start])) {
    start -= 1;
  }
  if (text[start] !== "/") {
    return null;
  }
  if (text.slice(0, start).trim().length > 0) {
    return null;
  }
  const queryStart = start + 1;
  let end = queryStart;
  while (end < text.length && isSlashCommandChar(text[end])) {
    end += 1;
  }
  if (boundedCursor < queryStart || boundedCursor > end) {
    return null;
  }
  return {
    end,
    query: text.slice(queryStart, boundedCursor),
    start,
    trigger: "/",
  };
}

export function replaceComposerTriggerToken(
  text: string,
  token: Pick<ComposerTriggerToken, "end" | "start">,
  insertText: string,
): { cursor: number; text: string } {
  const needsTrailingSpace = token.end >= text.length || !/\s/.test(text[token.end] ?? "");
  const replacement = `${insertText}${needsTrailingSpace ? " " : ""}`;
  const cursorOffset = replacement.length + (!needsTrailingSpace && /\s/.test(text[token.end] ?? "") ? 1 : 0);
  return {
    cursor: token.start + cursorOffset,
    text: `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`,
  };
}

function isSlashCommandChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value);
}
