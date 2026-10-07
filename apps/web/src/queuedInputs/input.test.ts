import { appendResponseAnnotations } from "../composer/annotations";
import { expect, it } from "vitest";

import { editableQueueText, queueInputPreview, replaceQueueText, restorableQueueText } from "./input";

it("edits only the selected text block and preserves unfamiliar native variants and fields", () => {
  const input = [
    { type: "text", text: "你好 $skill", text_elements: [{ byteRange: { start: 7, end: 13 }, placeholder: "$skill" }], nativeField: "keep" },
    { type: "image", fileId: "opaque", detail: "original" },
    { type: "futureInput", nested: { untouched: true } },
    { type: "text", text: "second", text_elements: [] },
  ];
  expect(editableQueueText(input)).toEqual([{ index: 0, text: "你好 $skill" }, { index: 3, text: "second" }]);
  expect(replaceQueueText(input, new Map([[0, "Edited"]]))).toEqual([
    { ...input[0], text: "Edited", text_elements: [] }, ...input.slice(1),
  ]);
  expect(input[0].text).toBe("你好 $skill");
  expect(queueInputPreview(input)).toContain("你好 $skill");
  expect(restorableQueueText(input)).toBeNull();
});

it("offers lossless composer restoration only for representable plain text", () => {
  expect(restorableQueueText([{ type: "text", text: "Saved correction", text_elements: [] }])).toBe("Saved correction");
  for (const input of [
    [{ type: "text", text: "one" }, { type: "text", text: "two" }],
    [{ type: "text", text: "token", text_elements: [{ placeholder: "token" }] }],
    [{ type: "text", text: "content", unknown: "must retain" }],
    [{ type: "localImage", path: "/saved.png" }],
  ]) expect(restorableQueueText(input)).toBeNull();
});

it("keeps native attachment envelopes out of message editing and preserves their exact input", () => {
  const envelope = { type: "text", text: "```kodex-attachments\n- .kodex/uploads/chat/file-1/notes.md\n```", text_elements: [] };
  const input = [{ type: "text", text: "Review this file" }, envelope];
  expect(editableQueueText(input)).toEqual([{ index: 0, text: "Review this file" }]);
  expect(queueInputPreview(input)).toBe("Review this file");
  expect(replaceQueueText(input, new Map([[0, "Compare this file"], [1, "accidental replacement"]])))
    .toEqual([{ type: "text", text: "Compare this file", text_elements: [] }, envelope]);
});

it("previews message and annotation comments without quotes or transport markup", () => {
  const text = appendResponseAnnotations("Please revise", [
    { id: "one", text: "Long assistant quote", comment: "Make this shorter" },
    { id: "two", text: "Another quote", comment: "Keep <this> detail" },
  ]);
  const input = [{ type: "text", text }];
  expect(queueInputPreview(input)).toBe("Please revise\nMake this shorter\nKeep <this> detail");
  expect(editableQueueText(input)).toEqual([{ index: 0, text }]);
  expect(input[0].text).toBe(text);
});

it("previews annotation-only input and labels uncommented quotes", () => {
  expect(queueInputPreview([{ type: "text", text: appendResponseAnnotations("", [{ id: "one", text: "Quote", comment: "Do this" }]) }])).toBe("Do this");
  expect(queueInputPreview([{ type: "text", text: appendResponseAnnotations("", [{ id: "one", text: "Quote", comment: "" }]) }])).toBe("Quoted message");
});

it("preserves literal or incomplete annotation markup in ordinary text", () => {
  const text = "Explain <response_annotations> and how it works";
  expect(queueInputPreview([{ type: "text", text }])).toBe(text);
});
