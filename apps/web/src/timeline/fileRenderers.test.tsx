import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactMarkdownRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const React = await import("react");
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      reactMarkdownRenderSpy(props.children);
      return React.createElement(actual.default, props);
    },
  };
});

import { TimelineActivityGroupRenderer, TimelineFileChangesRenderer, TimelineItemRenderer } from "./renderers";
import type { TimelineItem } from "./reducer";

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: "item-1",
    kind: "agent_message",
    status: "completed",
    text: "",
    turnId: "turn-1",
    displayOrder: 1,
    payload: {},
    debugEvents: [],
    ...overrides,
  };
}

function openDetails(details: HTMLDetailsElement) {
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("timeline file renderers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
  });

  it("renders file change output as an inspectable unified diff", async () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            action: "Modified",
            kind: "file_change",
            output: "@@ -1 +1 @@\n-old\n+new",
            path: "timeline-rendering-feedback.md",
          })}
        />
      </MantineProvider>,
    );

    expect(await screen.findByLabelText(/file diff for timeline-rendering-feedback\.md/i)).toBeInTheDocument();
    expect(screen.queryByText("update")).not.toBeInTheDocument();
    expect(screen.queryByText("timeline-rendering-feedback.md")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("defers activity item body rendering until the row is opened", async () => {
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          showDebug
          items={[
            item({
              action: "Modified",
              debugEvents: [
                {
                  id: "event-1",
                  seq: 1,
                  kind: "gateway.warning",
                  codexMethod: "item/completed",
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "file-1",
                  projectId: "project-1",
                  payload: { output: "diff body" },
                  receivedAt: "2026-04-30T00:00:00Z",
                },
              ],
              id: "file-1",
              kind: "file_change",
              output: "@@ -1 +1 @@\n-old\n+new",
              path: "timeline-rendering-feedback.md",
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Modified timeline-rendering-feedback.md")).toBeInTheDocument();
    expect(screen.queryByLabelText(/file diff for timeline-rendering-feedback\.md/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/item\/completed/i)).not.toBeInTheDocument();

    const activityDetails = container.querySelector("details.kodex-activity-item") as HTMLDetailsElement;
    openDetails(activityDetails);

    expect(await screen.findByLabelText(/file diff for timeline-rendering-feedback\.md/i)).toBeInTheDocument();
    expect(screen.getByText(/item\/completed/i)).toBeInTheDocument();
  });

  it("renders aggregated file changes and expands diffs only for modified files", async () => {
    const { container } = render(
      <MantineProvider>
        <TimelineFileChangesRenderer
          entries={[
            {
              id: "file-added",
              action: "Added",
              additions: 1,
              deletions: 0,
              diff: "+new file contents",
              itemIds: ["file-added"],
              path: "src/new.ts",
            },
            {
              id: "file-deleted",
              action: "Deleted",
              additions: 0,
              deletions: 1,
              diff: "-old file contents",
              itemIds: ["file-deleted"],
              path: "src/old.ts",
            },
            {
              id: "file-modified",
              action: "Modified",
              additions: 2,
              deletions: 2,
              diff: "@@ -1 +1 @@\n-old\n+new\n@@ -4 +4 @@\n-before\n+after",
              itemIds: ["file-modified", "file-modified-again"],
              path: "src/App.tsx",
            },
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("3 files changed")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText("src/old.ts")).toBeInTheDocument();
    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(container.querySelectorAll("details.kodex-file-change-entry")).toHaveLength(1);
    expect(screen.queryByLabelText(/file diff for src\/new\.ts/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/file diff for src\/old\.ts/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/file diff for src\/app\.tsx/i)).not.toBeInTheDocument();

    openDetails(container.querySelector("details.kodex-file-change-entry") as HTMLDetailsElement);

    expect(await screen.findByLabelText(/file diff for src\/app\.tsx/i)).toBeInTheDocument();
  });
});
