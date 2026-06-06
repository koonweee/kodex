import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { TimelineActivityGroupRenderer, TimelineItemRenderer, TimelineWorkRowRenderer } from "./renderers";
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

describe("timeline activity renderers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
  });

  it("marks failed command activity in collapsed and expanded command renderings", () => {
    render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              command: "ls missing-file",
              kind: "command_execution",
              output: "ls: missing-file: No such file or directory",
              status: "failed",
            }),
          ]}
        />
      </MantineProvider>,
    );

    const commandDetails = document.querySelector("details.kodex-activity-item");
    expect(commandDetails).toBeInTheDocument();
    expect(within(commandDetails as HTMLElement).getAllByText(/failed/i)).not.toHaveLength(0);
    expect(within(commandDetails as HTMLElement).queryByText(/success/i)).not.toBeInTheDocument();
  });

  it("renders reasoning and web search as compact structured blocks", async () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            id: "reasoning-1",
            kind: "reasoning_summary",
            summary: "Need current sources.",
            payload: { item: { type: "reasoning", summary: "Need current sources." } },
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "web-search-turn-1",
            kind: "web_search_group",
            actions: [
              { kind: "search", query: "Codex app server" },
              { kind: "open", title: "Example", url: "https://example.com" },
            ],
            payload: {},
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.getByText(/searched web for/i)).toBeInTheDocument();
    expect(screen.getByText(/codex app server/i)).toBeInTheDocument();
    expect(screen.getByText(/opened page/i)).toBeInTheDocument();
    expect(screen.getByText(/example/i)).toBeInTheDocument();
    expect(screen.queryByText(/"query"/i)).not.toBeInTheDocument();
  });

  it("renders supporting timeline activity as a nested collapsible group", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              id: "cmd-1",
              kind: "command_execution",
              command: "pwd",
              cwd: "/home/example/kodex",
              output: "/home/example/kodex\n",
            }),
            item({
              id: "cmd-2",
              kind: "command_execution",
              command: "rg --files",
              output: "apps/web/src/App.tsx\napps/web/src/timeline/renderers.tsx\n",
            }),
            item({
              id: "web-1",
              kind: "web_search_group",
              actions: [{ kind: "search", query: "Codex app server" }],
            }),
            item({
              id: "collab-1",
              kind: "collab_agent_tool_call",
              text: "Finished waiting",
              toolName: "wait",
              resultSummary: "No major issues remain.",
            }),
            item({
              id: "image-1",
              kind: "image_generation",
              text: "Generated image",
              output: "completed",
              path: "/tmp/generated.png",
              resultSummary: "A diagram",
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-activity-group")).not.toHaveAttribute("open");
    expect(screen.getByText("Searched web, used 1 agent, generated 1 image, ran 2 commands")).toBeInTheDocument();
    expect(screen.getByText("Ran pwd")).toBeInTheDocument();
    expect(screen.getByText("Listed files")).toBeInTheDocument();
    expect(screen.getAllByText("Finished waiting").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Generated image").length).toBeGreaterThan(0);

    const activityItems = Array.from(container.querySelectorAll("details.kodex-activity-item")) as HTMLDetailsElement[];
    activityItems.forEach(openDetails);

    expect(screen.getByText(/no major issues remain/i)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/generated\.png/i)).toBeInTheDocument();
    expect(screen.getByText(/Result: completed/i)).toBeInTheDocument();
    expect(screen.getByText("$ pwd")).toBeInTheDocument();
    expect(screen.getByText("/home/example/kodex")).toBeInTheDocument();
    expect(screen.getAllByText("Shell")).not.toHaveLength(0);
  });

  it("renders structured collaboration activity with Markdown result previews", async () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            id: "collab-spawn",
            kind: "collab_agent_tool_call",
            text: "Spawned Lorentz [explorer]",
            toolName: "spawnAgent",
            collab: {
              agents: [{ threadId: "thread-lorentz", displayName: "Lorentz [explorer]", nickname: "Lorentz", role: "explorer" }],
              model: "gpt-5.5",
              reasoningEffort: "high",
              prompt: "Inspect the renderer behavior and summarize the result.",
            },
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "collab-wait",
            kind: "collab_agent_tool_call",
            text: "Finished waiting",
            toolName: "wait",
            collab: {
              agents: [
                {
                  threadId: "thread-lorentz",
                  displayName: "Lorentz [explorer]",
                  status: "Completed",
                  rawStatus: "completed",
                  message: "**Done**\n\n- checked `renderers.tsx`\n- see [plan](plans/collab-agent-timeline-rendering.md)",
                },
              ],
            },
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Spawned Lorentz [explorer]")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.5")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Inspect the renderer behavior and summarize the result.")).toBeInTheDocument();
    expect(screen.getAllByText("Lorentz [explorer]").length).toBeGreaterThan(0);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    await waitFor(() => expect(reactMarkdownRenderSpy).toHaveBeenCalledWith(expect.stringContaining("**Done**")));
    expect(await screen.findByText("Done", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("renderers.tsx")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "plan" })).toHaveAttribute(
      "href",
      "plans/collab-agent-timeline-rendering.md",
    );
    expect(container).not.toHaveTextContent("thread-lorentz");
  });

  it("summarizes grouped collaboration rows with friendly names and counts", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              id: "collab-spawn",
              kind: "collab_agent_tool_call",
              text: "Spawned Lorentz [explorer]",
              toolName: "spawnAgent",
              collab: {
                agents: [{ threadId: "thread-lorentz", displayName: "Lorentz [explorer]" }],
              },
            }),
            item({
              id: "collab-wait",
              kind: "collab_agent_tool_call",
              text: "Finished waiting",
              toolName: "wait",
              collab: {
                agents: [
                  { threadId: "thread-lorentz", displayName: "Lorentz [explorer]", status: "Completed" },
                  { threadId: "thread-mill", displayName: "Mill", status: "Running" },
                ],
              },
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Used 2 agents")).toBeInTheDocument();
    expect(screen.getByText("Spawned Lorentz [explorer]")).toBeInTheDocument();
    expect(screen.getByText("Finished waiting")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("thread-lorentz");
    expect(container).not.toHaveTextContent("thread-mill");
  });

  it("renders completed work rows as collapse controls without nesting detail rows", async () => {
    const onExpandedChange = vi.fn();
    const workRow = {
      type: "work" as const,
      key: "work-turn-1",
      turnKey: "turn-turn-1",
      turnId: "turn-1",
      state: "completed" as const,
      startedAtMs: 1_000,
      completedAtMs: 65_000,
      displayOrder: 1.1,
      collapsedRows: [
        {
          type: "item" as const,
          key: "item-reasoning-1",
          turnKey: "turn-turn-1",
          turnId: "turn-1",
          displayOrder: 2,
          item: item({
            id: "reasoning-1",
            kind: "reasoning_summary",
            summary: "Need context.",
            text: "Need context.",
            displayOrder: 2,
          }),
        },
      ],
    };
    const { container, rerender } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          expanded={false}
          onExpandedChange={onExpandedChange}
          row={workRow}
        />
      </MantineProvider>,
    );

    const details = container.querySelector("details.kodex-work-row");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector(".kodex-work-header-divider")).toBeInTheDocument();
    expect(details?.querySelector("summary > .kodex-work-header-divider")).toBeInTheDocument();
    expect(screen.getByText("Worked for 1m 04s")).toBeInTheDocument();
    expect(screen.queryByText("Need context.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Worked for 1m 04s"));
    await waitFor(() => expect(onExpandedChange).toHaveBeenCalledWith(true));

    rerender(
      <MantineProvider>
        <TimelineWorkRowRenderer
          expanded
          onExpandedChange={onExpandedChange}
          row={workRow}
        />
      </MantineProvider>,
    );
    expect(container.querySelector("details.kodex-work-row")).toHaveAttribute("open");
    expect(screen.queryByText("Need context.")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-collapsed-rows")).not.toBeInTheDocument();
  });

  it("renders completed work rows without a caret when there is nothing to expand", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "completed",
            startedAtMs: 1_000,
            completedAtMs: 6_000,
            displayOrder: 1.1,
            collapsedRows: [],
          }}
        />
      </MantineProvider>,
    );

    expect(container.querySelector("details.kodex-work-row")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-caret")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-work-header-divider")).toBeInTheDocument();
    expect(screen.getByText("Worked for 5s")).toBeInTheDocument();
  });

  it("renders running work rows with the header divider", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "running",
            startedAtMs: Date.now(),
            displayOrder: 1.1,
            collapsedRows: [],
          }}
        />
      </MantineProvider>,
    );

    expect(screen.getByText(/Working for/)).toBeInTheDocument();
    expect(container.querySelector(".kodex-work-header-divider")).toBeInTheDocument();
  });

  it("renders running work rows without elapsed time when no canonical start exists", () => {
    render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "running",
            displayOrder: 1.1,
            collapsedRows: [],
          }}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText(/Working for/)).not.toBeInTheDocument();
  });

  it("renders plan, review mode, and context compaction timeline markers", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer item={item({ id: "plan-1", kind: "plan", text: "1. Inspect\n2. Patch" })} />
        <TimelineItemRenderer
          item={item({
            id: "review-start",
            kind: "review_mode_started",
            text: "Code review started: Review image support",
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "review-end",
            kind: "review_mode_finished",
            text: "Code review finished",
          })}
        />
        <TimelineItemRenderer
          item={item({
            id: "compact-1",
            kind: "context_compaction",
            text: "Context compacted",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/1\. Inspect\s+2\. Patch/)).toBeInTheDocument();
    expect(screen.getByText("Code review started: Review image support")).toBeInTheDocument();
    expect(screen.getByText("Code review finished")).toBeInTheDocument();
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported item/i)).not.toBeInTheDocument();
  });

  it("renders context compaction markers without a row header", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            id: "compact-1",
            kind: "context_compaction",
            text: "Context compacted",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.queryByText("Context")).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-timeline-item-header")).not.toBeInTheDocument();
  });

  it("keeps long command summaries truncatable while showing the full command in the shell block", () => {
    const command = "/usr/bin/zsh -lc \"sed -n '960,1140p' apps/web/src/App.tsx\"";
    const { container } = render(
      <MantineProvider>
        <TimelineActivityGroupRenderer
          items={[
            item({
              id: "cmd-long",
              kind: "command_execution",
              command,
              cwd: "/home/example/kodex",
              output: "function TimelineView() {}\n",
            }),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Ran sed -n '960,1140p' apps/web/src/App.tsx")).toHaveAttribute(
      "title",
      "Ran sed -n '960,1140p' apps/web/src/App.tsx",
    );

    openDetails(container.querySelector("details.kodex-activity-item") as HTMLDetailsElement);

    expect(screen.getByText("$ sed -n '960,1140p' apps/web/src/App.tsx")).toBeInTheDocument();
    expect(screen.queryByText("/home/example/kodex")).not.toBeInTheDocument();
  });

  it("shows debug event metadata and raw payload only when debug mode is enabled", () => {
    const debugItem = item({
      kind: "debug_event",
      text: "Unsupported item",
      payload: { item: { type: "futureThing", value: true } },
      debugEvents: [
        {
          id: "event-1",
          seq: 1,
          kind: "gateway.warning",
          codexMethod: "item/started",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          projectId: "project-1",
          payload: { item: { type: "futureThing", value: true } },
          receivedAt: "2026-04-30T00:00:00Z",
        },
      ],
    });

    const { rerender } = render(
      <MantineProvider>
        <TimelineItemRenderer item={debugItem} />
      </MantineProvider>,
    );

    expect(screen.getByText("Unsupported item")).toBeInTheDocument();
    expect(screen.queryByText(/futureThing/i)).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <TimelineItemRenderer item={debugItem} showDebug />
      </MantineProvider>,
    );

    expect(screen.getByText(/item\/started/i)).toBeInTheDocument();
    expect(screen.getByText(/futureThing/i)).toBeInTheDocument();
  });
});
