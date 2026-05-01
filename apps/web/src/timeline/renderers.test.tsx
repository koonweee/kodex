import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";

import { TimelineActivityGroupRenderer, TimelineItemRenderer } from "./renderers";
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

  it("renders human labels, hides normal completed status, and keeps raw payloads out of the default view", () => {
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

    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.queryByText(/assistant_message/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agentMessage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/item\/completed/i)).not.toBeInTheDocument();
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
          ]}
        />
      </MantineProvider>,
    );

    expect(container.querySelector(".kodex-activity-group")).not.toHaveAttribute("open");
    expect(screen.getByText("Searched web, ran 2 commands")).toBeInTheDocument();
    expect(screen.getByText("Ran pwd")).toBeInTheDocument();
    expect(screen.getByText("Listed files")).toBeInTheDocument();
    expect(screen.getByText("$ pwd")).toBeInTheDocument();
    expect(screen.getByText("/home/example/kodex")).toBeInTheDocument();
    expect(screen.getAllByText("Shell")).not.toHaveLength(0);
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
