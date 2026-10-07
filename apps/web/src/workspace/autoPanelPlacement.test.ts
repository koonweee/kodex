import { createDockview, Orientation, type DockviewApi } from "dockview";
import { describe, expect, it } from "vitest";
import { autoPanelPlacement, panelPlacementOptions } from "./autoPanelPlacement";

function dock(groups: { id: string; width: number; height: number; location?: string; visible?: boolean }[], orientation = Orientation.HORIZONTAL) {
  const panels = groups.map(({ id, width, height, location = "grid", visible = true }) => ({
    id,
    group: { id, api: { width, height, location: { type: location }, isVisible: visible }, activePanel: { id } },
  }));
  return {
    toJSON: () => ({ grid: { orientation, root: { type: "branch", data: panels.map(panel => ({ type: "leaf", data: { id: panel.id } })) } } }),
    groups: panels.map((panel) => panel.group),
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
  } as unknown as DockviewApi;
}

const place = (api: DockviewApi, id = "a") => autoPanelPlacement(api, id, 6);

describe("automatic pane placement", () => {
  it("splits a wide pane horizontally", () => {
    expect(place(dock([{ id: "a", width: 1200, height: 900 }]))).toEqual({ referencePanel: "a", direction: "right" });
  });
  it("splits a narrow tall column vertically", () => {
    expect(place(dock([{ id: "a", width: 700, height: 900 }]))).toEqual({ referencePanel: "a", direction: "below" });
  });
  it("fills another roomy column before making an existing tile smaller", () => {
    expect(place(dock([{ id: "a", width: 700, height: 447 }, { id: "b", width: 700, height: 900 }]))).toEqual({ referencePanel: "b", direction: "below" });
  });
  it("uses a tab when neither direction leaves usable panes", () => {
    expect(place(dock([{ id: "a", width: 700, height: 450 }]))).toEqual({ referencePanel: "a", direction: "within" });
    expect(place(dock([{ id: "a", width: 400, height: 1200 }]))).toEqual({ referencePanel: "a", direction: "within" });
  });
  it("includes the sash gap at width and height boundaries", () => {
    expect(place(dock([{ id: "a", width: 965, height: 645 }])).direction).toBe("within");
    expect(place(dock([{ id: "a", width: 966, height: 645 }])).direction).toBe("right");
    expect(place(dock([{ id: "a", width: 965, height: 646 }])).direction).toBe("below");
  });
  it.each(["floating", "popout", "edge"])("does not choose %s groups as spare space", (location) => {
    expect(place(dock([{ id: "a", width: 600, height: 400 }, { id: "b", width: 1400, height: 900, location }])).referencePanel).toBe("a");
  });
  it("does not split hidden groups", () => {
    expect(place(dock([{ id: "a", width: 600, height: 400 }, { id: "b", width: 1400, height: 900, visible: false }])).referencePanel).toBe("a");
  });
  it.each(["right", "below", "within"] as const)("honors explicit %s placement even at capacity", (direction) => {
    const consumed = new Set<string>();
    expect(panelPlacementOptions(dock([{ id: "a", width: 600, height: 400 }]),
      { id: "new", kind: "terminal", title: null, target: {} }, null,
      { new: { referencePaneId: "a", direction } }, consumed, 6,
    )).toEqual({ floating: false, position: { referencePanel: "a", direction } });
    expect([...consumed]).toEqual(["new"]);
  });
  it("avoids horizontal redistribution when a manually narrowed neighbor would make the new columns too thin", () => {
    expect(place(dock([{ id: "a", width: 997, height: 900 }, { id: "b", width: 203, height: 900 }]))).toEqual({ referencePanel: "a", direction: "below" });
  });
  it("avoids vertical redistribution beside a manually shortened row", () => {
    expect(place(dock([{ id: "a", width: 700, height: 700 }, { id: "b", width: 700, height: 150 }], Orientation.VERTICAL))).toEqual({ referencePanel: "a", direction: "within" });
  });
  it("keeps nested columns readable when the outer source has room for a split", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const api = createDockview(element, {
      createComponent: () => ({ element: document.createElement("div"), init() {} }),
      theme: { name: "placement-test", className: "placement-test", gap: 6 },
    });
    try {
      api.layout(1950, 900);
      api.addPanel({ id: "a", component: "test" });
      api.addPanel({ id: "b", component: "test", position: { referencePanel: "a", direction: "right" } });
      api.addPanel({ id: "c", component: "test", position: { referencePanel: "b", direction: "below" } });
      api.addPanel({ id: "d", component: "test", position: { referencePanel: "b", direction: "right" } });
      for (const group of api.groups) expect(group.api.width).toBeGreaterThanOrEqual(480);

      const position = place(api);
      expect(position).toEqual({ referencePanel: "a", direction: "below" });
      api.addPanel({ id: "new", component: "test", position });

      expect(api.groups).toHaveLength(5);
      for (const group of api.groups) {
        expect(group.api.width).toBeGreaterThanOrEqual(480);
        expect(group.api.height).toBeGreaterThanOrEqual(320);
      }
    } finally {
      api.dispose();
      element.remove();
    }
  });
  it("uses a tab when layout dimensions are not yet available", () => {
    expect(place(dock([{ id: "a", width: 0, height: 0 }])).direction).toBe("within");
  });
});
