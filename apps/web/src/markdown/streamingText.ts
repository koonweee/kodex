import type { ExtraProps } from "react-markdown";

type Element = NonNullable<ExtraProps["node"]>;
type Node = Element["children"][number];
type Tree = { children: Node[] };
export type StreamingRun = { from: number; to: number; born: number };
export const STREAM_FADE_MS = 240;
const MAX_RUNS = 16;
const MAX_TAIL = 1000;
const MAX_GROUPS_PER_BATCH = 4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function appendStreamingRuns(previous: StreamingRun[], text: string, from: number, now: number): StreamingRun[] {
  const start = Math.max(from, text.length - MAX_TAIL);
  const runs = previous.filter(run => run.born + STREAM_FADE_MS > now && run.to > start - MAX_TAIL);
  // Keep each batch coarse enough to bound transient DOM and animation work while
  // retaining a phrase-like leading edge. Grapheme safety is checked below.
  const words = [...text.slice(start).matchAll(/\S+\s*/gu)];
  const groupSize = Math.max(1, Math.ceil(words.length / MAX_GROUPS_PER_BATCH));
  for (let i = 0; i < words.length; i += groupSize) {
    runs.push({ from: i === 0 ? start : start + words[i].index!,
      to: i + groupSize < words.length ? start + words[i + groupSize].index! : text.length,
      born: now + (i / groupSize) * 7 });
  }
  return runs.slice(-MAX_RUNS);
}

// Only decorate literal text whose source offsets still match. Markdown reclassification,
// entities, code and tables keep the canonical renderer's immediate presentation.
export function decorateStreamingText(tree: Tree, source: string, runs: StreamingRun[]): void {
  if (runs.length === 0) return;
  tree.children = tree.children.flatMap((node): Node[] => {
    if (node.type === "element") {
      if (!["code", "pre", "table"].includes(node.tagName)) decorateStreamingText(node, source, runs);
      return [node];
    }
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (node.type !== "text" || from === undefined || to === undefined || source.slice(from, to) !== node.value) return [node];
    // A delta may end halfway through an emoji or combining sequence. In that case,
    // preserve the renderer's single text node instead of splitting a grapheme.
    if (/[^\x00-\x7F]/.test(node.value)) {
      const graphemes = graphemeSegmenter.segment(node.value);
      if (runs.some(run => [run.from, run.to].some(offset => offset > from && offset < to
        && graphemes.containing(offset - from)?.index !== offset - from))) return [node];
    }
    const result: Node[] = [];
    let cursor = from;
    for (const run of runs) {
      const start = Math.max(cursor, run.from);
      const end = Math.min(to, run.to);
      if (end <= start) continue;
      if (start > cursor) result.push({ type: "text", value: source.slice(cursor, start) });
      result.push({ type: "element", tagName: "span", properties: { "data-stream-born": run.born }, children: [{ type: "text", value: source.slice(start, end) }] });
      cursor = end;
    }
    if (cursor === from) return [node];
    if (cursor < to) result.push({ type: "text", value: source.slice(cursor, to) });
    return result;
  });
}
