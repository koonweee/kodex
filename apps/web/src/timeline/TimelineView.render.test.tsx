import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtuosoMockContext } from "react-virtuoso";

import { TimelineView } from "./TimelineView";
import { timelineItem, timelineState } from "./testBuilders";

function renderWithTimelineProviders(ui: ReactElement) {
  return render(
    <MantineProvider>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
        {ui}
      </VirtuosoMockContext.Provider>
    </MantineProvider>,
  );
}

describe("TimelineView debug rendering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders 12-hour timestamps for visible user and final assistant messages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 13, 12, 0, 0));
    const timeline = timelineState({
      items: [
        timelineItem({
          id: "user-1",
          kind: "user_message",
          displayOrder: 1,
          text: "Older question",
          timestampMs: new Date(2026, 4, 13, 8, 1, 2).getTime(),
        }),
        timelineItem({
          id: "answer-1",
          kind: "assistant_message",
          displayOrder: 2,
          messagePhase: "final_answer",
          text: "Older answer",
          timestampMs: new Date(2026, 4, 12, 9, 2, 3).getTime(),
        }),
        timelineItem({
          id: "user-2",
          kind: "user_message",
          displayOrder: 3,
          text: "Latest question",
          timestampMs: new Date(2026, 4, 13, 10, 3, 4).getTime(),
        }),
        timelineItem({
          id: "answer-progress",
          kind: "assistant_message",
          displayOrder: 4,
          messagePhase: "progress",
          text: "Progress update",
          timestampMs: new Date(2026, 4, 13, 10, 30, 0).getTime(),
        }),
        timelineItem({
          id: "answer-2",
          kind: "assistant_message",
          displayOrder: 5,
          messagePhase: "final_answer",
          text: "Latest answer",
          timestampMs: new Date(2026, 4, 10, 11, 4, 5).getTime(),
        }),
      ],
    });

    renderWithTimelineProviders(
      <TimelineView
        approvals={[]}
        imagePreviewUrlsByPath={{}}
        onApprovalDecision={vi.fn()}
        onImageOpen={vi.fn()}
        onMarkdownOpen={vi.fn()}
        onReady={vi.fn()}
        scrollParentElement={null}
        showDebug={false}
        threadId="thread-1"
        timeline={timeline}
      />,
    );

    expect(screen.getByText("Latest question")).toBeInTheDocument();
    expect(screen.getByText("Latest answer")).toBeInTheDocument();
    expect(screen.getByText("8:01:02 AM")).toBeInTheDocument();
    expect(screen.getByText("yesterday 9:02:03 AM")).toBeInTheDocument();
    expect(screen.getByText("10:03:04 AM")).toBeInTheDocument();
    expect(screen.getByText("3d ago 11:04:05 AM")).toBeInTheDocument();
    expect(screen.queryByText("10:30:00 AM")).not.toBeInTheDocument();
    expect(screen.queryByText("10:03:04")).not.toBeInTheDocument();
  });

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

    const { rerender } = renderWithTimelineProviders(
      <TimelineView {...props} showDebug={false} />,
    );

    expect(screen.getByText("Visible question")).toBeInTheDocument();
    expect(screen.getByText("Visible answer")).toBeInTheDocument();
    expect(screen.queryByText("Hidden debug events")).not.toBeInTheDocument();
    expect(screen.queryByText("turn/completed")).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
          <TimelineView {...props} showDebug />
        </VirtuosoMockContext.Provider>
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

    renderWithTimelineProviders(
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
      />,
    );

    expect(screen.getByText("Hidden debug events")).toBeInTheDocument();
    expect(screen.getByText("thread/status")).toBeInTheDocument();
  });

  it("preserves the visual scroll anchor when older history prepends rows", () => {
    const scrollParentElement = document.createElement("div") as HTMLDivElement;
    Object.defineProperty(scrollParentElement, "clientHeight", { configurable: true, value: 720 });
    Object.defineProperty(scrollParentElement, "scrollHeight", { configurable: true, value: 1_000 });
    scrollParentElement.scrollTop = 120;

    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady: vi.fn(),
      scrollParentElement,
      showDebug: false,
      threadId: "thread-1",
    };
    const loadingTimeline = timelineState({
      hasOlderHistory: true,
      isLoadingOlderHistory: true,
      items: [
        timelineItem({ id: "recent-1", kind: "user_message", turnId: "turn-3", displayOrder: 3, text: "Recent question" }),
        timelineItem({ id: "recent-2", kind: "user_message", turnId: "turn-4", displayOrder: 4, text: "Recent answer" }),
      ],
    });
    const { rerender } = renderWithTimelineProviders(
      <TimelineView {...props} timeline={loadingTimeline} />,
    );

    Object.defineProperty(scrollParentElement, "scrollHeight", { configurable: true, value: 1_320 });
    rerender(
      <MantineProvider>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
          <TimelineView
            {...props}
            timeline={timelineState({
              hasOlderHistory: true,
              items: [
                timelineItem({ id: "older-1", kind: "user_message", turnId: "turn-1", displayOrder: 1, text: "Older question" }),
                timelineItem({ id: "older-2", kind: "user_message", turnId: "turn-2", displayOrder: 2, text: "Older answer" }),
                timelineItem({ id: "recent-1", kind: "user_message", turnId: "turn-3", displayOrder: 3, text: "Recent question" }),
                timelineItem({ id: "recent-2", kind: "user_message", turnId: "turn-4", displayOrder: 4, text: "Recent answer" }),
              ],
            })}
          />
        </VirtuosoMockContext.Provider>
      </MantineProvider>,
    );

    expect(scrollParentElement.scrollTop).toBe(440);
  });

  it("keeps later user messages in flow when an expanded file changes row grows", async () => {
    const user = userEvent.setup();
    const props = {
      approvals: [],
      imagePreviewUrlsByPath: {},
      onApprovalDecision: vi.fn(),
      onImageOpen: vi.fn(),
      onMarkdownOpen: vi.fn(),
      onReady: vi.fn(),
      scrollParentElement: null,
      showDebug: false,
      threadId: "thread-1",
    };
    const growingTimeline = (fileCount: number) =>
      timelineState({
        turns: [
          {
            completedAtMs: 6_000,
            itemIds: ["user-1", "answer-1"],
            startedAtMs: 1_000,
            status: "completed",
            turnId: "turn-1",
          },
        ],
        items: [
          timelineItem({ id: "user-1", kind: "user_message", displayOrder: 1, text: "Please inspect files." }),
          ...Array.from({ length: fileCount }, (_, index) =>
            timelineItem({
              id: `file-${index}`,
              kind: "file_change",
              displayOrder: index + 2,
              path: `src/file-${index}.ts`,
              turnId: "turn-1",
            }),
          ),
          timelineItem({
            id: "answer-1",
            kind: "assistant_message",
            displayOrder: fileCount + 2,
            messagePhase: "final_answer",
            text: "Finished changing files.",
            turnId: "turn-1",
          }),
          timelineItem({
            id: "user-2",
            kind: "user_message",
            displayOrder: fileCount + 3,
            text: "$implement-review-loop continue after the files changed block",
            turnId: "turn-2",
            skillMentions: [
              {
                end: "$implement-review-loop".length,
                name: "implement-review-loop",
                path: "/skills/implement-review-loop/SKILL.md",
                start: 0,
                displayName: "Implement Review Loop",
                brandColor: "#7c3aed",
              },
            ],
          }),
        ],
      });

    const { container, rerender } = renderWithTimelineProviders(
      <TimelineView {...props} timeline={growingTimeline(2)} />,
    );

    expect(screen.queryByText("2 files changed")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-collapsed-rows")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Implement Review Loop skill")).toBeInTheDocument();

    await user.click(screen.getByText(/Worked for/));
    expect(screen.getByText("2 files changed")).toBeInTheDocument();

    rerender(
      <MantineProvider>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 720, itemHeight: 96 }}>
          <TimelineView {...props} timeline={growingTimeline(23)} />
        </VirtuosoMockContext.Provider>
      </MantineProvider>,
    );

    expect(screen.getByText("12 files changed")).toBeInTheDocument();
    expect(screen.getByText("11 files changed")).toBeInTheDocument();
    expect(screen.getByLabelText("Implement Review Loop skill")).toBeInTheDocument();
    expect(container.querySelector(".kodex-work-collapsed-rows")).not.toBeInTheDocument();
    expect([...container.querySelectorAll<HTMLElement>(".kodex-timeline-virtual-row")].every((row) => !row.style.transform)).toBe(
      true,
    );
  });

  it("keeps a later user message rendered after expanding a file diff", async () => {
    const user = userEvent.setup();
    renderWithTimelineProviders(
      <TimelineView
        approvals={[]}
        imagePreviewUrlsByPath={{}}
        onApprovalDecision={vi.fn()}
        onImageOpen={vi.fn()}
        onMarkdownOpen={vi.fn()}
        onReady={vi.fn()}
        scrollParentElement={null}
        showDebug={false}
        threadId="thread-1"
        timeline={timelineState({
          items: [
            timelineItem({ id: "user-1", kind: "user_message", displayOrder: 1, text: "Please inspect files." }),
            timelineItem({
              id: "file-1",
              kind: "file_change",
              action: "modified",
              displayOrder: 2,
              output: "@@ -1 +1 @@\n-old\n+new",
              path: "src/file.ts",
            }),
            timelineItem({
              id: "user-2",
              kind: "user_message",
              displayOrder: 3,
              text: "$implement-review-loop continue after the files changed block",
              turnId: "turn-2",
              skillMentions: [
                {
                  end: "$implement-review-loop".length,
                  name: "implement-review-loop",
                  path: "/skills/implement-review-loop/SKILL.md",
                  start: 0,
                  displayName: "Implement Review Loop",
                  brandColor: "#7c3aed",
                },
              ],
            }),
          ],
        })}
      />,
    );

    await user.click(screen.getByText("Modified"));

    expect(screen.getByLabelText("File diff for src/file.ts")).toBeInTheDocument();
    expect(screen.getByLabelText("Implement Review Loop skill")).toBeInTheDocument();
  });
});
