import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EventEnvelope, ThreadViewResponse } from "../api/client";
import { applyLiveTimelineUpdate, applyTimelineSnapshot, createTimelineState } from "./reducer";
import type { TimelineWorkRow } from "./reducer";
import { TimelineWorkRowRenderer } from "./renderers";
import { timelineItem } from "./testBuilders";

function snapshot(state: string, errorMessage?: string): ThreadViewResponse {
  return {
    thread: { id: "thread-1" },
    liveState: "idle",
    timeline: {
      viewRevision: 2, activeTurnId: null, liveState: "idle", items: [], turns: [],
      pendingApprovalRequests: [], pendingUserInputRequests: [],
      rows: [{
        id: "work-turn-1", kind: "work", turnId: "turn-1", displayOrder: 1,
        status: state, timestampMs: null, item: null, items: [], fileChanges: [],
        work: { state, errorMessage, startedAt: 10, completedAt: 25 },
        collapsedRows: [], dividerBefore: null,
      }],
    },
  } as unknown as ThreadViewResponse;
}

function work(state: string, errorMessage?: string): TimelineWorkRow {
  return applyTimelineSnapshot(createTimelineState(), snapshot(state, errorMessage)).rows[0] as TimelineWorkRow;
}

describe("native failed and interrupted turns", () => {
  it("shows the native failure without requiring activity expansion", () => {
    render(<MantineProvider><TimelineWorkRowRenderer row={work("failed", "Sign in to continue.")} /></MantineProvider>);
    expect(screen.getByText("Failed after 15s")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Sign in to continue.");
    expect(screen.queryByText(/Worked/)).not.toBeInTheDocument();
  });

  it("keeps the failure visible while tool activity is collapsed", () => {
    const row = work("failed", "The native request failed.");
    row.collapsedRows = [{ type: "item", key: "tool", turnKey: row.turnKey, turnId: row.turnId, displayOrder: 2, item: timelineItem({ kind: "command_execution" }) }];
    const { container } = render(<MantineProvider><TimelineWorkRowRenderer row={row}>Tool output</TimelineWorkRowRenderer></MantineProvider>);
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The native request failed.");
    expect(screen.queryByText("Tool output")).not.toBeInTheDocument();
  });

  it("still explains a failed turn when native history has no retained error", () => {
    render(<MantineProvider><TimelineWorkRowRenderer row={work("failed")} /></MantineProvider>);
    expect(screen.getByRole("alert")).toHaveTextContent("The turn failed. No error details are available.");
  });

  it("labels an interrupted turn as stopped", () => {
    render(<MantineProvider><TimelineWorkRowRenderer row={work("interrupted")} /></MantineProvider>);
    expect(screen.getByText("Stopped after 15s")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows native interruption reasons without treating ordinary Stop as an error", () => {
    render(<MantineProvider><TimelineWorkRowRenderer row={work("interrupted", "Stopped by the approval guardrail.")} /></MantineProvider>);
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped by the approval guardrail.");
  });

  it("shows failures with no native timing", () => {
    const row = { ...work("failed"), startedAtMs: undefined, completedAtMs: undefined };
    render(<MantineProvider><TimelineWorkRowRenderer row={row} /></MantineProvider>);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    expect(screen.queryByText(/after/)).not.toBeInTheDocument();
  });

  it("converges live and reconnecting clients on the same native error", () => {
    const failed = snapshot("failed", "Sign in to continue.");
    const event = {
      id: "event-2", seq: 2, kind: "thread_view.patch", threadId: "thread-1",
      payload: { ...failed.timeline, threadId: "thread-1", scope: "full_snapshot" },
    } as EventEnvelope;
    const clientA = applyLiveTimelineUpdate(createTimelineState(), event);
    const clientB = applyTimelineSnapshot(createTimelineState(), failed);
    expect(clientA.rows).toEqual(clientB.rows);
    expect(clientA.rows[0]).toMatchObject({ state: "failed", errorMessage: "Sign in to continue." });
  });
});
