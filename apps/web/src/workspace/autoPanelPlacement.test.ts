import { createDockview, type DockviewApi } from "dockview";
import { afterEach, describe, expect, it } from "vitest";
import { autoPanelPlacement, panelPlacementOptions } from "./autoPanelPlacement";

const disposables: (() => void)[] = [];
afterEach(() => disposables.splice(0).forEach(dispose => dispose()));

function dock(width = 1200, height = 900) {
  const element = document.createElement("div");
  document.body.append(element);
  const api = createDockview(element, {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
    theme: { name: "placement-test", className: "placement-test", gap: 6 },
  });
  disposables.push(() => { api.dispose(); element.remove(); });
  api.layout(width, height);
  api.addPanel({ id: "a", component: "test" });
  return api;
}

const place = (api: DockviewApi) => autoPanelPlacement(api, 6);
function add(api: DockviewApi, id: string, source = "a") {
  api.getPanel(source)?.api.setActive();
  const position = place(api);
  api.addPanel({ id, component: "test", position });
  return position;
}

describe("predictable automatic pane placement", () => {
  it("appends three mobile-width columns at the far right independently of focus", () => {
    const api = dock();
    expect(add(api, "b")).toEqual({ direction: "right" });
    api.getPanel("a")!.api.setActive();
    expect(add(api, "c")).toEqual({ direction: "right" });
    const root = api.toJSON().grid.root;
    expect(Array.isArray(root.data) && root.data.map(node => !Array.isArray(node.data) && node.data.views[0])).toEqual(["a", "b", "c"]);
    for (const group of api.groups) {
      expect(group.api.width).toBeGreaterThanOrEqual(360);
      expect(group.api.width).toBeLessThan(480);
    }
  });
  it("fills a second row from right to left and then tabs at bottom-right", () => {
    const api = dock();
    add(api, "b");
    add(api, "c");
    expect(add(api, "d", "a")).toEqual({ referencePanel: "c", direction: "below" });
    expect(add(api, "e", "d")).toEqual({ referencePanel: "b", direction: "below" });
    expect(add(api, "f", "b")).toEqual({ referencePanel: "a", direction: "below" });
    expect(add(api, "g", "f")).toEqual({ referencePanel: "d", direction: "within" });
    expect(api.groups).toHaveLength(6);
    expect(api.getPanel("g")!.group).toBe(api.getPanel("d")!.group);
  });
  it("never creates a third row even on a very tall display", () => {
    const api = dock(600, 1800);
    expect(add(api, "b")).toEqual({ referencePanel: "a", direction: "below" });
    expect(add(api, "c")).toEqual({ referencePanel: "b", direction: "within" });
    expect(api.groups).toHaveLength(2);
  });
  it("tabs at the far right when there is not enough height to stack", () => {
    const api = dock(1200, 500);
    add(api, "b"); add(api, "c");
    expect(add(api, "d", "a")).toEqual({ referencePanel: "c", direction: "within" });
  });
  it("calculates column capacity from current workspace width", () => {
    const api = dock(800);
    add(api, "b");
    expect(place(api)).toEqual({ referencePanel: "b", direction: "below" });
    api.layout(1200, 900);
    expect(add(api, "c")).toEqual({ direction: "right" });
  });
  it("does not seek a roomier pane or recursively split custom nested layouts", () => {
    const api = dock(1950);
    api.addPanel({ id: "b", component: "test", position: { referencePanel: "a", direction: "right" } });
    api.addPanel({ id: "c", component: "test", position: { referencePanel: "b", direction: "below" } });
    api.addPanel({ id: "d", component: "test", position: { referencePanel: "b", direction: "right" } });
    expect(add(api, "e", "d")).toEqual({ referencePanel: "a", direction: "below" });
    expect(add(api, "f", "a")).toEqual({ referencePanel: "c", direction: "within" });
  });
  it("keeps the same order after restoring a saved layout", () => {
    const api = dock();
    add(api, "b"); add(api, "c"); add(api, "d");
    const saved = api.toJSON();
    api.fromJSON(saved);
    expect(add(api, "e", "a")).toEqual({ referencePanel: "b", direction: "below" });
  });
  it("stacks again after closed panes leave a vertical root with one group", () => {
    const api = dock(850);
    add(api, "b"); add(api, "c");
    api.removePanel(api.getPanel("a")!);
    api.removePanel(api.getPanel("b")!);
    api.layout(600, 900);
    const saved = api.toJSON();
    api.fromJSON(saved);
    expect(add(api, "d", "c")).toEqual({ referencePanel: "c", direction: "below" });
    expect(api.groups).toHaveLength(2);
  });
  it("includes divider space at the mobile-width boundary", () => {
    expect(place(dock(725, 500))).toEqual({ referencePanel: "a", direction: "within" });
    const api = dock(726, 500);
    expect(add(api, "b")).toEqual({ direction: "right" });
    for (const group of api.groups) expect(group.api.width).toBeGreaterThanOrEqual(360);
  });
  it("tabs at bottom-right instead of skipping a manually narrowed column", () => {
    const api = dock(850);
    add(api, "b");
    api.getPanel("a")!.api.setSize({ width: 550 });
    expect(api.getPanel("b")!.group.api.width).toBeLessThan(360);
    expect(add(api, "c")).toEqual({ referencePanel: "b", direction: "within" });
  });
  it("ignores floating groups and obsolete automatic source hints", () => {
    const api = dock(600, 400);
    api.addPanel({ id: "floating", component: "test", floating: { width: 1500, height: 900 } });
    expect(place(api)).toEqual({ referencePanel: "a", direction: "within" });
    expect(panelPlacementOptions(api, { id: "new", kind: "terminal", title: null, target: {} }, null,
      { new: { referencePaneId: "closed", direction: "auto" } }, new Set(), 6,
    )).toEqual({ floating: false, position: { referencePanel: "a", direction: "within" } });
  });
  it.each(["right", "below", "within"] as const)("preserves explicit %s placement", (direction) => {
    const api = dock(600, 400);
    const consumed = new Set<string>();
    expect(panelPlacementOptions(api, { id: "new", kind: "terminal", title: null, target: {} }, null,
      { new: { referencePaneId: "a", direction } }, consumed, 6,
    )).toEqual({ floating: false, position: { referencePanel: "a", direction } });
    expect([...consumed]).toEqual(["new"]);
  });
});
