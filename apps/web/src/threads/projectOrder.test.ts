import { describe, expect, it } from "vitest";

import type { Project } from "../api/client";
import {
  applySidebarProjectOrder,
  loadSidebarProjectOrder,
  moveProjectInSidebarOrder,
  moveProjectInSidebarOrderAt,
  saveSidebarProjectOrder,
} from "./projectOrder";

function project(id: string, createdAt: string): Project {
  return {
    createdAt,
    cwd: `/workspace/${id}`,
    id,
    name: id,
    updatedAt: createdAt,
  };
}

describe("sidebar project ordering", () => {
  it("defaults projects to newest-created first", () => {
    expect(
      applySidebarProjectOrder(
        [
          project("old", "2026-01-01T00:00:00Z"),
          project("new", "2026-03-01T00:00:00Z"),
          project("middle", "2026-02-01T00:00:00Z"),
        ],
        null,
      ).map((item) => item.id),
    ).toEqual(["new", "middle", "old"]);
  });

  it("puts projects missing from the manual order at the top until the next reorder", () => {
    expect(
      applySidebarProjectOrder(
        [
          project("old", "2026-01-01T00:00:00Z"),
          project("new", "2026-03-01T00:00:00Z"),
          project("middle", "2026-02-01T00:00:00Z"),
        ],
        ["middle", "missing", "old"],
      ).map((item) => item.id),
    ).toEqual(["new", "middle", "old"]);
  });

  it("moves projects by id and persists only ids", () => {
    const storage = window.localStorage;
    storage.clear();

    const order = moveProjectInSidebarOrder(["new", "middle", "old"], "old", "new");
    expect(order).toEqual(["old", "new", "middle"]);

    saveSidebarProjectOrder(order, storage);
    expect(loadSidebarProjectOrder(storage)).toEqual(["old", "new", "middle"]);
  });

  it("can move projects before or after a target id", () => {
    expect(moveProjectInSidebarOrderAt(["new", "middle", "old"], "old", "new", "before")).toEqual([
      "old",
      "new",
      "middle",
    ]);
    expect(moveProjectInSidebarOrderAt(["new", "middle", "old"], "old", "new", "after")).toEqual([
      "new",
      "old",
      "middle",
    ]);
  });
});
