import { render, screen } from "@testing-library/react";
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

import { TimelineItemRenderer } from "./renderers";
import { DebugDisclosure } from "./rendererShared";
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

describe("timeline renderer registry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(screen.getAllByText(/file change/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/modified src\/app\.tsx/i)).toBeInTheDocument();
    expect(screen.getByText(/low trust/i)).toBeInTheDocument();
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByText(/future_item/i)).toBeInTheDocument();
  });
});


describe("timeline debug disclosure", () => {
  it("shows the native item payload on request without inventing event metadata", () => {
    const payload = { type: "tool-invocation", toolInvocation: { toolCallId: "native-call", toolName: "execute_command", state: "result", args: { command: "pwd" }, result: "/project" } };
    const native = item({ turnId: null, kind: "dynamic_tool_call", toolName: "execute_command", payload });
    const view = render(<MantineProvider><TimelineItemRenderer item={native} /></MantineProvider>);
    expect(screen.queryByText("Debug details")).not.toBeInTheDocument();
    view.rerender(<MantineProvider><TimelineItemRenderer item={native} showDebug /></MantineProvider>);
    expect(screen.getByText("Debug details").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Item payload")).toBeInTheDocument();
    const debug = view.container.querySelector(".kodex-timeline-debug-payload");
    expect(JSON.parse(debug!.textContent!)).toEqual(payload);
    expect(native.debugEvents).toEqual([]);
  });

  it("retains existing event labels and payloads when events are available", () => {
    const event = { id: "event-1", seq: 1, kind: "gateway.warning", codexMethod: "item/completed", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", projectId: null, payload: { raw: "Event details" }, receivedAt: "2026-04-30T00:00:00Z" };
    const { container } = render(<MantineProvider><DebugDisclosure item={item({ payload: { ignored: "Item fallback" }, debugEvents: [event] })} /></MantineProvider>);
    expect(screen.getByText("item/completed · item-1")).toBeInTheDocument();
    expect(screen.queryByText("Item payload")).not.toBeInTheDocument();
    expect(JSON.parse(container.querySelector(".kodex-timeline-debug-payload")!.textContent!)).toEqual(event.payload);
  });

  it("summarizes only recognized inline media while retaining filenames, URLs and ordinary tool text", () => {
    const binary = "A".repeat(4 * 1024 * 1024), ordinary = "Unmodified output: " + "A".repeat(16000);
    const pdfData = "data:application/pdf;base64,QUJD";
    const payload = [
      { type: "file", mimeType: "image/png", filename: "input.png", data: binary },
      { type: "file", mimeType: "application/pdf", data: pdfData },
      { type: "file", mimeType: "image/png", data: "https://example.test/image.png" },
      { type: "tool-invocation", toolInvocation: { args: { data: ordinary }, result: { __workspaceMedia: true, text: "Image read", mediaType: "image/png", data: binary } } },
      { type: "text", text: ordinary },
    ];
    const { container } = render(<MantineProvider><DebugDisclosure item={item({ payload })} /></MantineProvider>);
    const shown = JSON.parse(container.querySelector(".kodex-timeline-debug-payload")!.textContent!);
    expect(shown).toEqual([
      { ...payload[0], data: `[Inline media omitted: ${binary.length} characters]` },
      { ...payload[1], data: `[Inline media omitted: ${pdfData.length} characters]` },
      payload[2],
      { type: "tool-invocation", toolInvocation: { args: { data: ordinary }, result: { __workspaceMedia: true, text: "Image read", mediaType: "image/png", data: `[Inline media omitted: ${binary.length} characters]` } } },
      payload[4],
    ]);
    expect(payload[0].data).toBe(binary);
  });
});
