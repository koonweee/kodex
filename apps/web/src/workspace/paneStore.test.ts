import { describe, expect, it } from "vitest";

import { createInstanceStorage } from "../api/instanceStorage";
import { loadSidebarDisclosureState, saveSidebarDisclosureState } from "../threads/sidebarDisclosureState";
import {
  createBrowserWorkspacePaneStore,
  createDefaultWorkspaceState,
  normalizeWorkspacePaneState,
  parseWorkspacePaneState,
  serializeWorkspacePaneState,
} from "./paneStore";
import type { WorkspacePaneState } from "./paneTypes";

describe("paneStore", () => {
  it("restores only this instance's references across independent browser clients", () => {
    window.localStorage.clear();
    const oldState: WorkspacePaneState = {
      ...createDefaultWorkspaceState(),
      panes: [{ id: "old-pane", kind: "thread", target: { mode: "existing", threadId: "old-thread" } }],
      activePaneId: "old-pane",
    };
    window.localStorage.setItem("kodex.workspace.panes.v1", JSON.stringify(oldState));
    const firstTab = createInstanceStorage("first", window.localStorage);
    const secondTab = createInstanceStorage("first", window.localStorage);
    const replacement = createInstanceStorage("replacement", window.localStorage);
    const firstStore = createBrowserWorkspacePaneStore(firstTab);
    expect(firstStore.load().panes[0]?.target).toEqual({ mode: "draft" });

    firstStore.save(oldState);
    saveSidebarDisclosureState({ chatsSectionCollapsed: false, collapsedProjectIds: new Set(["project-1"]), pinnedSectionCollapsed: false, projectsSectionCollapsed: false }, firstTab);

    expect(createBrowserWorkspacePaneStore(secondTab).load()).toEqual(oldState);
    expect(loadSidebarDisclosureState(secondTab).collapsedProjectIds).toEqual(new Set(["project-1"]));
    expect(createBrowserWorkspacePaneStore(replacement).load().panes[0]?.target).toEqual({ mode: "draft" });
    expect(loadSidebarDisclosureState(replacement).collapsedProjectIds.size).toBe(0);
    expect(createBrowserWorkspacePaneStore(firstTab).load()).toEqual(oldState);
  });

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
