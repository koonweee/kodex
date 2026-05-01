import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";

import { TimelineItemRenderer } from "./renderers";
import type { TimelineItem } from "./reducer";

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: "item-1",
    kind: "agent_message",
    status: "completed",
    text: "",
    payload: {},
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
});
