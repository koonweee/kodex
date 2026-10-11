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
      panes: [{ id: "old-pane", kind: "thread", target: { executorId: "local", mode: "existing", threadId: "old-thread" } }],
      activePaneId: "old-pane",
    };
    const firstTab = createInstanceStorage("first", window.localStorage);
    const secondTab = createInstanceStorage("first", window.localStorage);
    const replacement = createInstanceStorage("replacement", window.localStorage);
    const firstStore = createBrowserWorkspacePaneStore(firstTab);
    firstStore.save(oldState);
    expect(firstStore.load()).toEqual(oldState);

    firstStore.save(oldState);
    saveSidebarDisclosureState({ chatsSectionCollapsed: false, collapsedProjectIds: new Set(["project-1"]), pinnedCollapsed: false, projectsSectionCollapsed: false }, firstTab);

    expect(createBrowserWorkspacePaneStore(secondTab).load()).toEqual(oldState);
    expect(loadSidebarDisclosureState(secondTab).collapsedProjectIds).toEqual(new Set(["project-1"]));
    expect(createBrowserWorkspacePaneStore(replacement).load().panes[0]?.target).toEqual({ executorId: "local", mode: "draft" });
    expect(loadSidebarDisclosureState(replacement).collapsedProjectIds.size).toBe(0);
    expect(createBrowserWorkspacePaneStore(firstTab).load()).toEqual(oldState);
  });

  it("falls back to one draft chat pane for corrupted storage", () => {
    const state = parseWorkspacePaneState("{not-json");

    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.kind).toBe("thread");
    expect(state.panes[0]?.target).toEqual({ executorId: "local", mode: "draft" });
    expect(state.activePaneId).toBe(state.panes[0]?.id);
  });

  it("creates an empty executor-scoped workspace on its owning executor", () => {
    window.localStorage.clear();
    const storage = createInstanceStorage("federator", window.localStorage);

    const state = createBrowserWorkspacePaneStore(storage, "executor-a").load();

    expect(state.panes[0]?.target).toEqual({ executorId: "executor-a", mode: "draft" });
  });

  it("drops invalid panes and repairs the active pane id", () => {
    const state = normalizeWorkspacePaneState({
      activePaneId: "missing-pane",
      dockviewLayout: { panes: [{ id: "pane-thread-1" }] },
      panes: [
        { id: "pane-thread-1", kind: "thread", target: { executorId: "local", mode: "existing", threadId: "thread-1" } },
        { id: "pane-bad", kind: "thread", target: { executorId: "local", mode: "existing" } },
      ],
      schemaVersion: 2,
    });

    expect(state?.panes.map((pane) => pane.id)).toEqual(["pane-thread-1"]);
    expect(state?.activePaneId).toBe("pane-thread-1");
  });

  it("rejects pane references that do not name their owning executor", () => {
    const state = normalizeWorkspacePaneState({
      activePaneId: "unqualified",
      dockviewLayout: null,
      panes: [
        { id: "unqualified", kind: "thread", target: { mode: "existing", threadId: "shared-thread" } },
        { id: "qualified", kind: "thread", target: { executorId: "executor-a", mode: "existing", threadId: "shared-thread" } },
      ],
      schemaVersion: 2,
    });

    expect(state?.panes).toEqual([
      { id: "qualified", kind: "thread", target: { executorId: "executor-a", mode: "existing", threadId: "shared-thread" } },
    ]);
    expect(state?.activePaneId).toBe("qualified");
  });

  it("serializes only the versioned frontend pane state contract", () => {
    const state: WorkspacePaneState = {
      ...createDefaultWorkspaceState(),
      dockviewLayout: { panes: [{ id: "pane-thread-1" }] },
      panes: [{ id: "pane-thread-1", kind: "thread", target: { executorId: "local", mode: "existing", threadId: "thread-1" } }],
      activePaneId: "pane-thread-1",
    };

    expect(serializeWorkspacePaneState(state)).toEqual(state);
  });
});
