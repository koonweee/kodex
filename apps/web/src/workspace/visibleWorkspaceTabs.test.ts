import { describe, expect, it } from "vitest";
import { visibleWorkspaceTabs } from "./visibleWorkspaceTabs";

describe("visible workspace tabs", () => {
  it("keeps the selected tab visible without changing native order", () => {
    expect(visibleWorkspaceTabs(["one", "two", "three", "four"], "four", 2)).toEqual(["one", "four"]);
    expect(visibleWorkspaceTabs(["one", "two", "three", "four"], "three", 2)).toEqual(["one", "three"]);
  });
  it("keeps visible neighbors stable when selecting a tab already shown", () => {
    expect(visibleWorkspaceTabs(["one", "two", "three", "four"], "one", 2, ["one", "four"])).toEqual(["one", "four"]);
    expect(visibleWorkspaceTabs(["one", "two", "three", "four"], "three", 2, ["one", "four"])).toEqual(["one", "three"]);
    expect(visibleWorkspaceTabs(["one", "two", "three", "four"], "four", 3, ["one", "four"])).toEqual(["one", "two", "four"]);
    expect(visibleWorkspaceTabs(["one", "two", "three"], "one", 2, ["one", "removed"])).toEqual(["one", "two"]);
  });
  it("retains fitting tabs when the selected tab is already among them", () => {
    expect(visibleWorkspaceTabs(["one", "two", "three"], "two", 2)).toEqual(["one", "two"]);
  });
  it("reveals every tab when the group grows and restores the selected tab when it shrinks", () => {
    const ids = ["one", "two", "three"];
    expect(visibleWorkspaceTabs(ids, "three", 5)).toEqual(ids);
    expect(visibleWorkspaceTabs(ids, "three", 1)).toEqual(["three"]);
  });
  it("keeps one selected tab in a very narrow group and handles removed selection", () => {
    expect(visibleWorkspaceTabs(["one", "two"], "two", 0)).toEqual(["two"]);
    expect(visibleWorkspaceTabs(["one", "two"], "removed", 1)).toEqual(["one"]);
    expect(visibleWorkspaceTabs([], undefined, 1)).toEqual([]);
  });
});
