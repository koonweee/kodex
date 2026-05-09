import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TimelineView } from "./TimelineView";
import { timelineItem, timelineState } from "./testBuilders";

describe("TimelineView debug rendering", () => {
  it("keeps hidden debug events out of visible row order while exposing them in a debug panel", () => {
    const timeline = timelineState({
      items: [
        timelineItem({ id: "answer-1", kind: "assistant_message", displayOrder: 2, text: "Visible answer" }),
        timelineItem({ id: "user-1", kind: "user_message", displayOrder: 1, text: "Visible question" }),
      ],
      hiddenItems: [
        timelineItem({ id: "debug-1", kind: "debug_event", displayOrder: 0, text: "turn/completed" }),
      ],
    });
    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady: vi.fn(),
      scrollParentElement: null,
      threadId: "thread-1",
      timeline,
    };

    const { rerender } = render(
      <MantineProvider>
        <TimelineView {...props} showDebug={false} />
      </MantineProvider>,
    );

    expect(screen.getByText("Visible question")).toBeInTheDocument();
    expect(screen.getByText("Visible answer")).toBeInTheDocument();
    expect(screen.queryByText("Hidden debug events")).not.toBeInTheDocument();
    expect(screen.queryByText("turn/completed")).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <TimelineView {...props} showDebug />
      </MantineProvider>,
    );

    const question = screen.getByText("Visible question");
    const answer = screen.getByText("Visible answer");
    const panel = screen.getByText("Hidden debug events");
    expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("turn/completed")).toBeInTheDocument();
  });

  it("shows hidden debug events even when there are no visible timeline rows", () => {
    const timeline = timelineState({
      hiddenItems: [
        timelineItem({ id: "debug-only-1", kind: "debug_event", displayOrder: 1, text: "thread/status" }),
      ],
    });

    render(
      <MantineProvider>
        <TimelineView
          approvals={[]}
          imagePreviewUrlsByPath={{}}
          onApprovalDecision={vi.fn()}
          onImageOpen={vi.fn()}
          onMarkdownOpen={vi.fn()}
          onReady={vi.fn()}
          scrollParentElement={null}
          showDebug
          threadId="thread-1"
          timeline={timeline}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Hidden debug events")).toBeInTheDocument();
    expect(screen.getByText("thread/status")).toBeInTheDocument();
  });
});
