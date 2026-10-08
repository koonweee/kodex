import { describe, expect, it } from "vitest";
import { appendStreamingRuns, decorateStreamingText } from "./streamingText";

describe("streaming Markdown decoration", () => {
  it("decorates only newly appended literal text without changing its contents", () => {
    const source = "Earlier words. Fresh words.";
    const runs = appendStreamingRuns([], source, 15, 100);
    const tree = { children: [{ type: "text" as const, value: source, position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: source.length + 1, offset: source.length } } }] };
    decorateStreamingText(tree, source, runs);
    expect(tree.children[0]).toMatchObject({ type: "text", value: "Earlier words. " });
    expect(tree.children.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "element", tagName: "span" })]));
  });

  it("drops expired runs and bounds decoration for a large incoming burst", () => {
    const old = appendStreamingRuns([], "old", 0, 0);
    const next = appendStreamingRuns(old, "old" + " word".repeat(2000), 3, 1000);
    expect(next.length).toBeLessThanOrEqual(16);
    expect(next.every(run => run.born >= 1000)).toBe(true);
    expect(Math.min(...next.map(run => run.from))).toBeGreaterThan(8000);
  });

  it("renders transformed text and code immediately instead of guessing source offsets", () => {
    const source = "&amp; code";
    const tree = { children: [
      { type: "text" as const, value: "&", position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 6, offset: 5 } } },
      { type: "element" as const, tagName: "code", properties: {}, children: [{ type: "text" as const, value: "code", position: { start: { line: 1, column: 7, offset: 6 }, end: { line: 1, column: 11, offset: 10 } } }] },
    ] };
    const before = JSON.stringify(tree);
    decorateStreamingText(tree, source, appendStreamingRuns([], source, 0, 10));
    expect(JSON.stringify(tree)).toBe(before);
  });
});
