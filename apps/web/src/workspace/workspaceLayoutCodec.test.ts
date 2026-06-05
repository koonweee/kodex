import { describe, expect, it } from "vitest";

import type { WorkspaceModel, WorkspacePane } from "./paneTypes";
import {
  compactWorkspaceLayout,
  hasDockviewPanels,
  layoutMatchesWorkspacePanes,
  workspaceLayoutPanelIds,
} from "./workspaceLayoutCodec";

describe("workspaceLayoutCodec", () => {
  it("reads compact fallback layouts", () => {
    const layout = { activePaneId: "pane-a", panes: [{ id: "pane-a" }, { id: "pane-b" }] };

    expect(workspaceLayoutPanelIds(layout)).toEqual(["pane-a", "pane-b"]);
    expect(layoutMatchesWorkspacePanes(layout, [pane("pane-a"), pane("pane-b")])).toBe(true);
  });

  it("reads Dockview serialized panel ids", () => {
    const layout = { panels: { "pane-a": {}, "pane-b": {} }, grid: { root: {} } };

    expect(hasDockviewPanels(layout)).toBe(true);
    expect(workspaceLayoutPanelIds(layout)).toEqual(["pane-a", "pane-b"]);
    expect(layoutMatchesWorkspacePanes(layout, [pane("pane-a"), pane("pane-c")])).toBe(false);
  });

  it("creates compact layouts from the workspace document", () => {
    const workspace: WorkspaceModel = {
      activePaneId: "pane-b",
      dockviewLayout: {},
      panes: [pane("pane-a"), pane("pane-b")],
      schemaVersion: 1,
    };

    expect(compactWorkspaceLayout(workspace)).toEqual({
      activePaneId: "pane-b",
      panes: [{ id: "pane-a" }, { id: "pane-b" }],
    });
  });
});

function pane(id: string): WorkspacePane {
  return {
    id,
    kind: "thread",
    target: { mode: "draft" },
  };
}
