import type { DockviewApi, IDockviewPanel } from "dockview";
import { describe, expect, it, vi } from "vitest";
import { applyResponsiveWorkspaceMode, serializeWorkspaceDock, type ResponsiveDockviewSession } from "./responsiveDockview";

function nativeDock() {
  let maximized: IDockviewPanel | undefined;
  const groups = ["one", "two"].map(id => ({ id, activePanel: undefined as IDockviewPanel | undefined, api: { isMaximized: () => maximized?.group.id === id } }));
  const panels = groups.map(group => ({ id: group.id, group, api: { isMaximized: () => maximized?.group === group } })) as unknown as IDockviewPanel[];
  groups.forEach((group, index) => { group.activePanel = panels[index]; });
  const api = {
    groups, panels, activePanel: panels[0], getPanel: (id: string) => panels.find(panel => panel.id === id),
    maximizeGroup: vi.fn((panel: IDockviewPanel) => { maximized = panel; }),
    exitMaximizedGroup: vi.fn(() => { maximized = undefined; }),
    toJSON: () => ({ panels: { one: {}, two: {} }, activeGroup: api.activePanel.id,
      grid: { width: 1200, height: 800, orientation: "HORIZONTAL", root: { type: "branch", data: [
        { type: "leaf", size: 800, data: { id: "one", views: ["one"] } },
        { type: "leaf", size: 400, data: { id: "two", views: ["two"] } },
      ] }, ...(maximized ? { maximizedNode: { location: [panels.indexOf(maximized)] } } : {}) } }),
  };
  return { api: api as unknown as DockviewApi, harness: api };
}
function session(): ResponsiveDockviewSession { return { active: false, previousMaximizedPanelId: null }; }

describe("responsive native workspace maximize", () => {
  it("maximizes the current pane once and restores split layout without persisting the responsive maximize", () => {
    const { api, harness } = nativeDock();
    const state = session();
    const split = api.toJSON();
    applyResponsiveWorkspaceMode(api, true, state);
    applyResponsiveWorkspaceMode(api, true, state);
    expect(harness.maximizeGroup).toHaveBeenCalledTimes(1);
    expect(serializeWorkspaceDock(api, state)).toEqual(split);
    expect(api.toJSON().grid).toHaveProperty("maximizedNode");
    applyResponsiveWorkspaceMode(api, false, state);
    expect(harness.exitMaximizedGroup).toHaveBeenCalledTimes(1);
    expect(api.toJSON()).toEqual(split);
    applyResponsiveWorkspaceMode(api, false, state);
    expect(harness.exitMaximizedGroup).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit desktop maximize through narrowing and widening", () => {
    const { api, harness } = nativeDock();
    api.maximizeGroup(api.activePanel!);
    const original = api.toJSON();
    const state = session();
    applyResponsiveWorkspaceMode(api, true, state);
    expect(serializeWorkspaceDock(api, state)).toEqual(original);
    applyResponsiveWorkspaceMode(api, false, state);
    expect(harness.exitMaximizedGroup).not.toHaveBeenCalled();
    expect(api.toJSON()).toEqual(original);
  });

  it("does not persist responsive maximize after the explicitly maximized pane is closed", () => {
    const { api, harness } = nativeDock();
    api.maximizeGroup(api.activePanel!);
    const state = session();
    applyResponsiveWorkspaceMode(api, true, state);
    harness.panels.splice(0, 1);
    harness.activePanel = harness.panels[0];
    applyResponsiveWorkspaceMode(api, true, state);
    expect(serializeWorkspaceDock(api, state).grid).not.toHaveProperty("maximizedNode");
    applyResponsiveWorkspaceMode(api, false, state);
    expect(harness.exitMaximizedGroup).toHaveBeenCalledTimes(1);
  });

  it("follows a different group selection and returns to splits as native explicit-maximize navigation does", () => {
    const { api, harness } = nativeDock();
    api.maximizeGroup(api.activePanel!);
    const state = session();
    applyResponsiveWorkspaceMode(api, true, state);
    harness.activePanel = harness.panels[1];
    applyResponsiveWorkspaceMode(api, true, state);
    expect(harness.maximizeGroup).toHaveBeenLastCalledWith(harness.panels[1]);
    expect(serializeWorkspaceDock(api, state).grid).not.toHaveProperty("maximizedNode");
    applyResponsiveWorkspaceMode(api, false, state);
    expect(harness.exitMaximizedGroup).toHaveBeenCalledTimes(1);
    expect(api.activePanel).toBe(harness.panels[1]);
  });
});
