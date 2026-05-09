import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("does not auto-scroll streamed updates after upward wheel intent near the bottom", async () => {
    const scrollParentElement = document.createElement("div");
    document.body.appendChild(scrollParentElement);
    Object.defineProperties(scrollParentElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 3600 },
      scrollTop: { configurable: true, writable: true, value: 3200 },
    });

    const onReady = vi.fn();
    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady,
      scrollParentElement,
      showDebug: false,
      threadId: "thread-1",
    };
    const timeline = timelineState({
      activeTurnId: "turn-1",
      items: Array.from({ length: 30 }, (_, index) =>
        timelineItem({
          id: `answer-${index}`,
          displayOrder: index,
          status: "running",
          text: `Large answer ${index}`,
        }),
      ),
      lastSeq: 1,
    });

    let unmount: (() => void) | undefined;
    try {
      const rendered = render(
        <MantineProvider>
          <TimelineView {...props} timeline={timelineState()} />
        </MantineProvider>,
        { container: scrollParentElement },
      );
      unmount = rendered.unmount;
      const { rerender } = rendered;

      await waitFor(() => expect(onReady).toHaveBeenCalled());
      rerender(
        <MantineProvider>
          <TimelineView {...props} timeline={timeline} />
        </MantineProvider>,
      );
      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3200);
      });
      scrollParentElement.scrollTop = 3200;
      fireEvent.scroll(scrollParentElement);

      fireEvent.wheel(scrollParentElement, { deltaY: -24 });
      scrollParentElement.scrollTop = 3120;
      fireEvent.scroll(scrollParentElement);

      rerender(
        <MantineProvider>
          <TimelineView
            {...props}
            timeline={timelineState({
              ...timeline,
              items: [
                ...timeline.items,
                timelineItem({
                  id: "streamed-answer",
                  displayOrder: 30,
                  status: "running",
                  text: "Streaming answer",
                }),
              ],
              lastSeq: 2,
            })}
          />
        </MantineProvider>,
      );

      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3120);
      });
    } finally {
      unmount?.();
      scrollParentElement.remove();
    }
  });

  it("keeps following live output when streamed text growth fires a scroll event without scroll movement", async () => {
    const scrollParentElement = document.createElement("div");
    document.body.appendChild(scrollParentElement);
    let scrollHeight = 3600;
    Object.defineProperties(scrollParentElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 3200 },
    });

    const onReady = vi.fn();
    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady,
      scrollParentElement,
      showDebug: false,
      threadId: "thread-1",
    };
    const timeline = timelineState({
      activeTurnId: "turn-1",
      items: [
        timelineItem({
          id: "streamed-answer",
          displayOrder: 1,
          status: "running",
          text: "Streaming answer",
        }),
      ],
      lastSeq: 1,
    });

    let unmount: (() => void) | undefined;
    try {
      const rendered = render(
        <MantineProvider>
          <TimelineView {...props} timeline={timelineState()} />
        </MantineProvider>,
        { container: scrollParentElement },
      );
      unmount = rendered.unmount;
      const { rerender } = rendered;

      await waitFor(() => expect(onReady).toHaveBeenCalled());
      rerender(
        <MantineProvider>
          <TimelineView {...props} timeline={timeline} />
        </MantineProvider>,
      );
      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3200);
      });

      scrollHeight = 3720;
      fireEvent.scroll(scrollParentElement);

      rerender(
        <MantineProvider>
          <TimelineView
            {...props}
            timeline={timelineState({
              ...timeline,
              items: [
                timelineItem({
                  id: "streamed-answer",
                  displayOrder: 1,
                  status: "running",
                  text: "Streaming answer with more text",
                }),
              ],
              lastSeq: 2,
            })}
          />
        </MantineProvider>,
      );

      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3320);
      });
    } finally {
      unmount?.();
      scrollParentElement.remove();
    }
  });

  it("keeps following live output when streamed text changes increase layout height after render", async () => {
    const scrollParentElement = document.createElement("div");
    document.body.appendChild(scrollParentElement);
    let scrollHeight = 3600;
    Object.defineProperties(scrollParentElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 3200 },
    });

    const onReady = vi.fn();
    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady,
      scrollParentElement,
      showDebug: false,
      threadId: "thread-1",
    };
    const timeline = timelineState({
      activeTurnId: "turn-1",
      items: [
        timelineItem({
          id: "streamed-answer",
          displayOrder: 1,
          status: "running",
          text: "Streaming answer",
        }),
      ],
      lastSeq: 1,
    });

    let unmount: (() => void) | undefined;
    try {
      const rendered = render(
        <MantineProvider>
          <TimelineView {...props} timeline={timelineState()} />
        </MantineProvider>,
        { container: scrollParentElement },
      );
      unmount = rendered.unmount;
      const { rerender } = rendered;

      await waitFor(() => expect(onReady).toHaveBeenCalled());
      rerender(
        <MantineProvider>
          <TimelineView {...props} timeline={timeline} />
        </MantineProvider>,
      );
      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3200);
      });

      rerender(
        <MantineProvider>
          <TimelineView
            {...props}
            timeline={timelineState({
              ...timeline,
              items: [
                timelineItem({
                  id: "streamed-answer",
                  displayOrder: 1,
                  status: "running",
                  text: "Streaming answer with enough markdown to grow after measurement",
                }),
              ],
              lastSeq: 2,
            })}
          />
        </MantineProvider>,
      );
      requestAnimationFrame(() => {
        scrollHeight = 4200;
      });

      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3800);
      });
    } finally {
      unmount?.();
      scrollParentElement.remove();
    }
  });

  it("keeps following live output after layout-driven scroll events move the viewport upward", async () => {
    const scrollParentElement = document.createElement("div");
    document.body.appendChild(scrollParentElement);
    let scrollHeight = 3600;
    Object.defineProperties(scrollParentElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 3200 },
    });

    const onReady = vi.fn();
    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady,
      scrollParentElement,
      showDebug: false,
      threadId: "thread-1",
    };
    const timeline = timelineState({
      activeTurnId: "turn-1",
      items: [
        timelineItem({
          id: "streamed-answer",
          displayOrder: 1,
          status: "running",
          text: "Streaming answer",
        }),
      ],
      lastSeq: 1,
    });

    let unmount: (() => void) | undefined;
    try {
      const rendered = render(
        <MantineProvider>
          <TimelineView {...props} timeline={timelineState()} />
        </MantineProvider>,
        { container: scrollParentElement },
      );
      unmount = rendered.unmount;
      const { rerender } = rendered;

      await waitFor(() => expect(onReady).toHaveBeenCalled());
      rerender(
        <MantineProvider>
          <TimelineView {...props} timeline={timeline} />
        </MantineProvider>,
      );
      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3200);
      });

      scrollParentElement.scrollTop = 3160;
      fireEvent.scroll(scrollParentElement);
      scrollHeight = 3920;

      rerender(
        <MantineProvider>
          <TimelineView
            {...props}
            timeline={timelineState({
              ...timeline,
              items: [
                timelineItem({
                  id: "streamed-answer",
                  displayOrder: 1,
                  status: "running",
                  text: "Streaming answer after layout-driven scroll",
                }),
              ],
              lastSeq: 2,
            })}
          />
        </MantineProvider>,
      );

      await waitFor(() => {
        expect(scrollParentElement.scrollTop).toBe(3520);
      });
    } finally {
      unmount?.();
      scrollParentElement.remove();
    }
  });
});
