import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { appendResponseAnnotations } from "../composer/annotations";
import { UserMessageBubble } from "./messageRenderers";
import type { TimelineItem } from "./reducer";

function renderMessage(text: string, overrides: Partial<TimelineItem> = {}) {
  const item: TimelineItem = { id: "user-1", kind: "user_message", status: "completed", text,
    turnId: "turn-1", displayOrder: 1, payload: {}, debugEvents: [], ...overrides };
  return render(<MantineProvider><UserMessageBubble item={item} imagePreviewUrlsByPath={{}} toolbarTimestampMs={0} /></MantineProvider>);
}

const annotations = [
  { id: "one", text: 'A "quote"\nwith <tags> & code', comment: "What comes next?" },
  { id: "two", text: "Keep the client thin.", comment: "Keep this constraint." },
];

describe("sent response annotations", () => {
  it("renders separate main text and multiple decoded quote/comment pairs in one message", () => {
    const { container } = renderMessage(appendResponseAnnotations("Plan the next milestone.", annotations));
    expect(screen.getByText("Plan the next milestone.")).toBeInTheDocument();
    for (const [index, annotation] of annotations.entries()) {
      const group = screen.getByRole("group", { name: `Annotation ${index + 1}` });
      expect(group.querySelector("blockquote")?.textContent).toBe(annotation.text);
      expect(group.querySelector("summary")).toHaveAccessibleName(annotation.text);
      expect(within(group).getByText(annotation.comment)).toBeVisible();
      expect(group.querySelector("details")).toHaveAttribute("open");
    }
    expect(container.textContent).not.toContain("<response_annotations>");
    expect(container.querySelector("tags")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(1);
  });

  it("renders quote-only annotations without an empty main message or comment", () => {
    const { container } = renderMessage(appendResponseAnnotations("", [{ ...annotations[0], comment: "" }]));
    expect(screen.getByRole("group", { name: "Annotation 1" }).querySelector("blockquote")?.textContent).toBe(annotations[0].text);
    expect(container.querySelectorAll(".kodex-user-annotation-comment")).toHaveLength(0);
    expect(container.querySelector(".kodex-user-annotation-main")).toBeNull();
  });

  it("keeps malformed blocks and normal messages verbatim", () => {
    const text = 'Hello\n\n<response_annotations>\n<annotation1>\nAssistant text: "broken\n</annotation1>\n</response_annotations>';
    const { container } = renderMessage(text);
    expect(container.querySelector(".kodex-user-message-bubble")?.textContent).toBe(text);
    expect(screen.queryByRole("group", { name: "Annotation 1" })).toBeNull();
  });

  it("preserves skill badges in the main message and copies readable quote/comment text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderMessage(appendResponseAnnotations("Use $review", annotations), {
      skillMentions: [{ start: 4, end: 11, name: "review", path: "/skills/review/SKILL.md" }],
    });
    expect(screen.getByLabelText("$review skill")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(writeText).toHaveBeenCalledWith('Use $review\n\n> A "quote"\n> with <tags> & code\n\nWhat comes next?\n\n> Keep the client thin.\n\nKeep this constraint.');
    expect(await screen.findByRole("button", { name: "Copied message" })).toBeInTheDocument();
  });
});
