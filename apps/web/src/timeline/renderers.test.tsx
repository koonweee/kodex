import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    seq: 1,
    payload: {},
    debugEvents: [],
    ...overrides,
  };
}

describe("timeline renderer registry", () => {
  beforeEach(() => {
    reactMarkdownRenderSpy.mockClear();
  });

  it("renders command, file change, warning, error, and unknown items through one registry", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer item={item({ kind: "command_execution", payload: { command: "cargo test" } })} />
        <TimelineItemRenderer item={item({ id: "item-2", kind: "file_change", payload: { path: "src/App.tsx" } })} />
        <TimelineItemRenderer item={item({ id: "item-3", kind: "warning", text: "Low trust" })} />
        <TimelineItemRenderer item={item({ id: "item-4", kind: "error", text: "Boom" })} />
        <TimelineItemRenderer item={item({ id: "item-5", kind: "future_item", payload: { ok: true } })} />
      </MantineProvider>,
    );

    expect(screen.getByText(/cargo test/i)).toBeInTheDocument();
    expect(screen.getByText(/src\/app\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/low trust/i)).toBeInTheDocument();
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByText(/future_item/i)).toBeInTheDocument();
  });

  it("hides message headings, hides normal completed status, and keeps raw payloads out of the default view", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text: "Done.",
            payload: { item: { type: "agentMessage", text: "Done." } },
            debugEvents: [
              {
                id: "event-1",
                seq: 1,
                kind: "codex.notification",
                codexMethod: "item/completed",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "item-1",
                projectId: "project-1",
                payload: { item: { type: "agentMessage", text: "Done." } },
                receivedAt: "2026-04-30T00:00:00Z",
              },
            ],
          })}
        />
      </MantineProvider>,
    );

    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.queryByText(/assistant_message/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agentMessage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/item\/completed/i)).not.toBeInTheDocument();
  });

  it("renders user image thumbnails above the message bubble", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          imagePreviewUrlsByPath={{ "/tmp/diagram.png": "blob:kodex-test" }}
          onImageOpen={onImageOpen}
          item={item({
            kind: "user_message",
            text: "Inspect this",
            images: [{ path: "/tmp/diagram.png" }],
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Inspect this")).toBeInTheDocument();
    expect(document.querySelector(".kodex-user-image-grid img")).toHaveAttribute("src", "blob:kodex-test");
    fireEvent.click(screen.getByRole("button", { name: /open \/tmp\/diagram\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: "blob:kodex-test",
      title: "/tmp/diagram.png",
    });
  });

  it("opens displayable image activity thumbnails", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onImageOpen={onImageOpen}
          item={item({
            kind: "image_generation",
            path: "https://example.test/generated.png",
            text: "Generated image",
          })}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open https:\/\/example\.test\/generated\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: "https://example.test/generated.png",
      title: "https://example.test/generated.png",
    });
  });

  it("renders generated image data URLs without showing raw base64 output", () => {
    const onImageOpen = vi.fn();
    render(
      <MantineProvider>
        <TimelineItemRenderer
          onImageOpen={onImageOpen}
          item={item({
            kind: "image_generation",
            imageSrc: "data:image/png;base64,iVBORw0KGgo=",
            path: "/tmp/generated.png",
            text: "Generated image",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.queryByText(/iVBORw0KGgo=/)).not.toBeInTheDocument();
    expect(screen.queryByText("Generated image")).not.toBeInTheDocument();
    expect(document.querySelector(".kodex-activity-image-preview img")).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    );
    fireEvent.click(screen.getByRole("button", { name: /open \/tmp\/generated\.png/i }));
    expect(onImageOpen).toHaveBeenCalledWith({
      alt: "",
      src: "data:image/png;base64,iVBORw0KGgo=",
      title: "/tmp/generated.png",
    });
  });

  it("renders subtle optimistic user message status", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "Ship it",
            source: "optimistic",
            confirmationState: "sending",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Ship it")).toBeInTheDocument();
    expect(screen.getByText("Sending")).toBeInTheDocument();
  });

  it("renders user messages as a right-aligned bubble and preserves newlines", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "user_message",
            text: "First line\nSecond line",
            payload: { item: { type: "userMessage", text: "First line\nSecond line" } },
          })}
        />
      </MantineProvider>,
    );

    const bubble = container.querySelector<HTMLElement>(".kodex-user-message-bubble");
    const row = container.querySelector<HTMLElement>(".kodex-user-message-row");
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(bubble).toBeInTheDocument();
    expect(bubble?.textContent).toBe("First line\nSecond line");
    expect(row).toContainElement(bubble);
    expect(container.querySelector(".kodex-timeline-item-header")).not.toBeInTheDocument();
  });

  it("renders assistant messages as safe markdown", () => {
    render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text:
              "For ZIP `94123`:\n\n- `52.8°F`, feels like `50.2°F`\n- Fog\n\nSource: [Open-Meteo](https://open-meteo.com/en/docs)\n\n<script>alert('x')</script>",
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("94123").tagName.toLowerCase()).toBe("code");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /open-meteo/i })).toHaveAttribute(
      "href",
      "https://open-meteo.com/en/docs",
    );
    expect(screen.getByRole("link", { name: /open-meteo/i })).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByText(/alert/i)).not.toBeInTheDocument();
  });

  it("keeps assistant markdown output stable for links, code, lists, breaks, and skipped HTML", () => {
    const { container, rerender } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text:
              "Use [docs](https://example.com/docs).\nNext line\n\n- one\n- `two`\n\n```ts\nconst value = 1;\n```\n\n<strong>hidden</strong>",
          })}
        />
      </MantineProvider>,
    );
    const initialMarkup = container.querySelector(".kodex-assistant-markdown")?.innerHTML;

    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("two").tagName.toLowerCase()).toBe("code");
    expect(container.querySelector(".kodex-timeline-code")).toHaveTextContent("const value = 1;");
    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
    expect(container.querySelector(".kodex-assistant-markdown strong")).not.toBeInTheDocument();

    rerender(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text:
              "Use [docs](https://example.com/docs).\nNext line\n\n- one\n- `two`\n\n```ts\nconst value = 1;\n```\n\n<strong>hidden</strong>",
          })}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-assistant-markdown")?.innerHTML).toBe(initialMarkup);
  });

  it("renders unlabeled fenced code blocks as block code", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            text: "Run this:\n\n```\nnpm test\n```",
          })}
        />
      </MantineProvider>,
    );

    const codeBlock = container.querySelector(".kodex-timeline-code");
    expect(codeBlock).toHaveTextContent("npm test");
    expect(container.querySelector(".kodex-assistant-inline-code")).not.toBeInTheDocument();
  });

  it("does not reparse completed assistant markdown on unrelated parent rerenders", () => {
    const completedItem = item({
      kind: "assistant_message",
      status: "completed",
      text: "Done with [docs](https://example.com).",
    });
    const CompletedHarness = ({ tick }: { tick: number }) => (
      <MantineProvider>
        <div data-testid="tick">{tick}</div>
        <TimelineItemRenderer item={{ ...completedItem }} />
      </MantineProvider>
    );

    const { rerender } = render(<CompletedHarness tick={0} />);
    expect(reactMarkdownRenderSpy).toHaveBeenCalledTimes(1);
    reactMarkdownRenderSpy.mockClear();

    rerender(<CompletedHarness tick={1} />);

    expect(screen.getByTestId("tick")).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    expect(reactMarkdownRenderSpy).not.toHaveBeenCalled();
  });

  it("updates streaming assistant markdown when message text changes", () => {
    const StreamingHarness = ({ text }: { text: string }) => (
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            status: "running",
            text,
          })}
        />
      </MantineProvider>
    );

    const { container, rerender } = render(<StreamingHarness text="Checking..." />);
    expect(screen.getByText("Checking...")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    reactMarkdownRenderSpy.mockClear();

    rerender(<StreamingHarness text={"Checking...\nFound source."} />);

    expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Checking...");
    expect(container.querySelector(".kodex-assistant-markdown")).toHaveTextContent("Found source.");
    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
    expect(reactMarkdownRenderSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves assistant markdown soft line breaks during streaming", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineItemRenderer
          item={item({
            kind: "assistant_message",
            status: "running",
            text: "Checking current conditions...\nSearching source results...",
          })}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-assistant-markdown br")).toBeInTheDocument();
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
    expect(screen.getByText(/no major issues remain/i)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/generated\.png/i)).toBeInTheDocument();
    expect(screen.getByText(/Result: completed/i)).toBeInTheDocument();
    expect(screen.getByText("$ pwd")).toBeInTheDocument();
    expect(screen.getByText("/home/example/kodex")).toBeInTheDocument();
    expect(screen.getAllByText("Shell")).not.toHaveLength(0);
  });

  it("renders completed work rows collapsed with elapsed time", () => {
    const { container } = render(
      <MantineProvider>
        <TimelineWorkRowRenderer
          imagePreviewUrlsByPath={{}}
          row={{
            type: "work",
            key: "work-turn-1",
            turnKey: "turn-turn-1",
            turnId: "turn-1",
            state: "completed",
            startedAtMs: 1_000,
            completedAtMs: 65_000,
            seq: 1.1,
            collapsedRows: [
              {
                type: "item",
                key: "item-reasoning-1",
                turnKey: "turn-turn-1",
                turnId: "turn-1",
                item: item({
                  id: "reasoning-1",
                  kind: "reasoning_summary",
                  summary: "Need context.",
                  text: "Need context.",
                  seq: 2,
                }),
              },
            ],
          }}
        />
      </MantineProvider>,
    );

    const details = container.querySelector("details.kodex-work-row");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Worked for 1m 04s")).toBeInTheDocument();
    expect(screen.getByText("Need context.")).toBeInTheDocument();
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

  it("keeps long command summaries truncatable while showing the full command in the shell block", () => {
    const command = "/usr/bin/zsh -lc \"sed -n '960,1140p' apps/web/src/App.tsx\"";
    render(
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
          kind: "codex.notification",
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
