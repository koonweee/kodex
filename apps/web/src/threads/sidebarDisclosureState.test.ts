import { describe, expect, it } from "vitest";

import {
  loadSidebarDisclosureState,
  saveSidebarDisclosureState,
  SIDEBAR_DISCLOSURE_STORAGE_KEY,
} from "./sidebarDisclosureState";

describe("sidebar disclosure state", () => {
  it("persists section and project collapse state", () => {
    const storage = window.localStorage;
    storage.clear();

    saveSidebarDisclosureState(
      {
        chatsSectionCollapsed: true,
        collapsedProjectIds: new Set(["project-1", "project-2"]),
        collapsedSectionIds: new Set(),
        projectsSectionCollapsed: true,
      },
      storage,
    );

    expect(loadSidebarDisclosureState(storage)).toEqual({
      chatsSectionCollapsed: true,
      collapsedProjectIds: new Set(["project-1", "project-2"]),
      collapsedSectionIds: new Set(),
      projectsSectionCollapsed: true,
    });
  });

  it("ignores malformed persisted values", () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem(
      SIDEBAR_DISCLOSURE_STORAGE_KEY,
      JSON.stringify({
        chatsSectionCollapsed: "true",
        collapsedProjectIds: ["project-1", "", 3, "project-2"],
        collapsedSectionIds: ["section-1", "", 3],
      }),
    );

    expect(loadSidebarDisclosureState(storage)).toEqual({
      chatsSectionCollapsed: false,
      collapsedProjectIds: new Set(["project-1", "project-2"]),
      collapsedSectionIds: new Set(["section-1"]),
      projectsSectionCollapsed: false,
    });
  });
});
