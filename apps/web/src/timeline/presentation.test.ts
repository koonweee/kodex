import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { createPresentationItem } from "./presentation";

function event(payload: unknown): EventEnvelope {
  return {
    id: "event-1",
    seq: 1,
    kind: "timeline.item_upsert",
    codexMethod: "item/updated",
    projectId: null,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    payload,
    receivedAt: "2026-06-04T00:00:00Z",
  };
}

describe("timeline presentation", () => {
  it("hides kodex attachment markers from materialized user message content", () => {
    const presented = createPresentationItem(
      event({
        item: {
          id: "item-1",
          type: "userMessage",
          content: [
            {
              type: "text",
              text: "Review this\n\n```kodex-attachments\n- .kodex/uploads/thread-1/file-1/notes.md\n```",
            },
          ],
        },
      }),
    );

    expect(presented?.item.text).toBe("Review this");
  });

  it("uses the saved image path when generated image bytes are compacted", () => {
    const presented = createPresentationItem(
      event({
        item: {
          id: "image-1",
          type: "imageGeneration",
          status: "completed",
          result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...[truncated]",
          saved_path: "/Users/example/.codex/generated_images/thread-1/image.png",
          revised_prompt: "A compact preview regression",
        },
      }),
    );

    expect(presented?.item.kind).toBe("image_generation");
    expect(presented?.item.imageSrc).toBeUndefined();
    expect(presented?.item.path).toBe("/Users/example/.codex/generated_images/thread-1/image.png");
    expect(presented?.item.resultSummary).toBe("A compact preview regression");
  });
});
