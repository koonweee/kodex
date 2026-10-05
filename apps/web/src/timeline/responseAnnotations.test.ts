import { describe, expect, it } from "vitest";
import { appendResponseAnnotations } from "../composer/annotations";
import { parseResponseAnnotations } from "./responseAnnotations";

function serialize(text: string, annotations: Array<{ text: string; comment: string }>): string {
  return appendResponseAnnotations(text, annotations.map((annotation, index) => ({
    ...annotation,
    id: String(index),
  })));
}

const single = serialize("", [{ text: "Quoted answer", comment: "Please explain" }]);

describe("parseResponseAnnotations", () => {
  it("round trips multiple annotations and preserves the main message exactly", () => {
    const text = "  Follow $skill\nnext line\n\n";
    const annotations = [
      { text: "First answer", comment: "Clarify this" },
      { text: "Second answer", comment: "" },
    ];
    expect(parseResponseAnnotations(serialize(text, annotations))).toEqual({ text, annotations });
  });

  it("round trips Unicode, multiline text, JSON escapes and annotation tags", () => {
    const annotations = [{
      text: '你好 🌿 e\u0301\n"quoted" \\ tab\t nul\u0000 <response_annotations> & </annotation1>',
      comment: 'line 1\nline 2\r\n<annotation2> "question" 🌍',
    }];
    expect(parseResponseAnnotations(serialize("Hello 👋", annotations))).toEqual({
      text: "Hello 👋", annotations,
    });
  });

  it("supports an annotation-only message and omitted comments", () => {
    const annotations = [{ text: "Answer", comment: "" }];
    expect(parseResponseAnnotations(serialize("", annotations))).toEqual({ text: "", annotations });
  });

  it("accepts previously serialized ordinary JSON strings", () => {
    const message = '<response_annotations>\n<annotation1>\nAssistant text: "<tag> & text"\nUser annotation: "why?"\n</annotation1>\n</response_annotations>';
    expect(parseResponseAnnotations(message)).toEqual({
      text: "", annotations: [{ text: "<tag> & text", comment: "why?" }],
    });
  });

  it.each([
    "plain message",
    "<response_annotations>\n</response_annotations>",
    single.replace("<annotation1>", "<annotation2>"),
    single.replaceAll("annotation1", "annotation01"),
    single.replace("</annotation1>", "</annotation2>"),
    single.replace('"Quoted answer"', "Quoted answer"),
    single.replace('"Quoted answer"', "123"),
    single.replace('"Quoted answer"', "null"),
    single.replace('"Quoted answer"', "[]"),
    single.replace('"Quoted answer"', '"Quoted answer" extra'),
    single.replace('"Quoted answer"', '"invalid\\escape"'),
    single.replace('"Quoted answer"', '"raw\nnewline"'),
    single.replace('"Please explain"', "true"),
    single.replace("User annotation:", "Unexpected field:"),
    single.replace("</annotation1>", "extra\n</annotation1>"),
    single.replace("</annotation1>", 'User annotation: "duplicate"\n</annotation1>'),
    single.replace("</annotation1>", "\n</annotation1>"),
    single.replace("</response_annotations>", ""),
    `${single}\ntrailing text`,
    `${single}\n`,
    `main text${single}`,
    `main text\n${single}`,
    `${single.replace("</response_annotations>", "")}<annotation1>\nAssistant text: "duplicate"\n</annotation1>\n</response_annotations>`,
  ])("leaves malformed or non-suffix annotation content untouched: %s", (message) => {
    expect(parseResponseAnnotations(message)).toBeNull();
  });

  it.each(["```xml", "~~~xml", "    ```xml", "````xml"])(
    "leaves an annotation example inside an unclosed fence untouched: %s", (fence) => {
      expect(parseResponseAnnotations(`${fence}\n\n${single}`)).toBeNull();
    },
  );

  it("leaves a fully fenced annotation example untouched", () => {
    expect(parseResponseAnnotations(`\`\`\`xml\n${single}\n\`\`\``)).toBeNull();
  });

  it("accepts annotations after a closed code fence", () => {
    const text = "Example:\n~~~~xml\n<annotation1>\n~~~~\n\nThen explain it.";
    const annotations = [{ text: "Answer", comment: "Question" }];
    expect(parseResponseAnnotations(serialize(text, annotations))).toEqual({ text, annotations });
  });

  it("rejects a skipped number in a later entry", () => {
    const message = serialize("", [
      { text: "First", comment: "" },
      { text: "Second", comment: "" },
    ]).replaceAll("annotation2", "annotation3");
    expect(parseResponseAnnotations(message)).toBeNull();
  });

  it("does not let a shorter or different fence close the example", () => {
    expect(parseResponseAnnotations(`\`\`\`\`xml\n\`\`\`\n~~~\n\n${single}`)).toBeNull();
  });
});
