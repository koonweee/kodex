import { describe, expect, it } from "vitest";

import {
  createDefaultWorkspaceState,
  normalizeWorkspacePaneState,
  parseWorkspacePaneState,
  serializeWorkspacePaneState,
} from "./paneStore";
import type { WorkspacePaneState } from "./paneTypes";

describe("paneStore", () => {
  it("falls back to one draft chat pane for corrupted storage", () => {
    const state = parseWorkspacePaneState("{not-json");

    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.kind).toBe("thread");
    expect(state.panes[0]?.target).toEqual({ mode: "draft" });
    expect(state.activePaneId).toBe(state.panes[0]?.id);
  });

  it("drops invalid panes and repairs the active pane id", () => {
    const state = normalizeWorkspacePaneState({
      activePaneId: "missing-pane",
      dockviewLayout: { panes: [{ id: "pane-thread-1" }] },
      panes: [
        { id: "pane-thread-1", kind: "thread", target: { mode: "existing", threadId: "thread-1" } },
        { id: "pane-bad", kind: "thread", target: { mode: "existing" } },
      ],
      schemaVersion: 1,
    });

    expect(state?.panes.map((pane) => pane.id)).toEqual(["pane-thread-1"]);
    expect(state?.activePaneId).toBe("pane-thread-1");
  });

  it("serializes only the versioned frontend pane state contract", () => {
    const state: WorkspacePaneState = {
      ...createDefaultWorkspaceState(),
      dockviewLayout: { panes: [{ id: "pane-thread-1" }] },
      panes: [{ id: "pane-thread-1", kind: "thread", target: { mode: "existing", threadId: "thread-1" } }],
      activePaneId: "pane-thread-1",
    };

    expect(serializeWorkspacePaneState(state)).toEqual(state);
  });
});
