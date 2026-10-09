import { expect, test, type Locator } from "@playwright/test";
import type { ThreadTimelineRow, ThreadViewResponse } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

type VerticalGeometry = {
  bottomInset: number;
  height: number;
  topInset: number;
};

for (const layout of [
  { name: "a regular fine-pointer pane", viewport: { width: 1100, height: 800 }, hasTouch: false },
  { name: "a compact touch pane", viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test(`intermediate summaries keep one density when collapsed and expanded in ${layout.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: layout.viewport, hasTouch: layout.hasTouch });
    const fixture = await nativeSettingsFixture(context);
    fixture.detail.timeline = intermediateTimeline();

    try {
      const page = await fixture.page("intermediate-density");
      const activity = page.locator(".kodex-activity-group");
      const activitySummary = activity.locator(":scope > summary");
      const files = page.locator(".kodex-file-changes-panel");
      const filesSummary = files.locator(":scope > summary");

      await expect(activitySummary).toBeVisible();
      await expect(filesSummary).toBeVisible();

      const activityCollapsed = await verticalGeometry(activitySummary, ".kodex-activity-heading");
      const filesCollapsed = await verticalGeometry(filesSummary, ".kodex-file-changes-title");

      await activitySummary.click();
      await filesSummary.click();

      const activityExpanded = await verticalGeometry(activitySummary, ".kodex-activity-heading");
      const filesExpanded = await verticalGeometry(filesSummary, ".kodex-file-changes-title");
      const commandSummary = activity.locator(".kodex-activity-item > summary").first();
      const fileSummary = files.locator(".kodex-file-change-summary").first();
      const commandExpanded = await verticalGeometry(commandSummary, ".kodex-activity-heading");
      const fileExpanded = await verticalGeometry(fileSummary, ".kodex-file-change-action");

      expect(Math.abs(activityExpanded.height - activityCollapsed.height)).toBeLessThanOrEqual(1);
      // The expanded file header gains its separator border without changing its
      // content inset or density.
      expect(Math.abs(filesExpanded.height - filesCollapsed.height)).toBeLessThanOrEqual(1);
      expectUniformDensity([
        activityCollapsed,
        activityExpanded,
        filesCollapsed,
        filesExpanded,
        commandExpanded,
        fileExpanded,
      ]);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      await context.close();
    }
  });

  test(`compact markers and substantive items use their assigned density in ${layout.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: layout.viewport, hasTouch: layout.hasTouch });
    const fixture = await nativeSettingsFixture(context);
    fixture.detail.timeline = mixedDensityTimeline();

    try {
      const page = await fixture.page("mixed-density");
      const contextCompacted = page.getByText("Context compacted", { exact: true });
      const plan = page.getByText("Inspect then patch", { exact: true });
      await expect(contextCompacted).toBeVisible();
      await expect(plan).toBeVisible();

      const contextBox = await contextCompacted.boundingBox();
      expect(contextBox).not.toBeNull();
      expect(contextBox!.height).toBeGreaterThanOrEqual(30);
      expect(contextBox!.height).toBeLessThanOrEqual(34);

      const planRow = page.locator(".kodex-turn-group").filter({ has: plan });
      const planGeometry = await verticalGeometry(planRow, ":scope > .kodex-timeline-item");
      expect(planGeometry.topInset).toBeGreaterThanOrEqual(7);
      expect(planGeometry.topInset).toBeLessThanOrEqual(9);
      expect(planGeometry.bottomInset).toBeGreaterThanOrEqual(7);
      expect(planGeometry.bottomInset).toBeLessThanOrEqual(9);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      await context.close();
    }
  });

  test(`work boundaries retain the default outer gap in ${layout.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: layout.viewport, hasTouch: layout.hasTouch });
    const fixture = await nativeSettingsFixture(context);
    fixture.detail.timeline = workBoundaryTimeline();

    try {
      const page = await fixture.page("work-density");
      const workLabel = page.getByText("Worked for 1s", { exact: true });
      await expect(workLabel).toBeVisible();

      const workRow = page.locator(".kodex-turn-group").filter({ has: workLabel });
      const workGeometry = await verticalGeometry(workRow, ":scope > .kodex-work-row");
      expect(workGeometry.topInset).toBeGreaterThanOrEqual(7);
      expect(workGeometry.topInset).toBeLessThanOrEqual(9);
      expect(workGeometry.bottomInset).toBeGreaterThanOrEqual(7);
      expect(workGeometry.bottomInset).toBeLessThanOrEqual(9);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      await context.close();
    }
  });
}

async function verticalGeometry(container: Locator, contentSelector: string): Promise<VerticalGeometry> {
  return container.evaluate((element, selector) => {
    const content = element.querySelector(selector);
    if (!(content instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
    const outer = element.getBoundingClientRect();
    const inner = content.getBoundingClientRect();
    return {
      bottomInset: outer.bottom - inner.bottom,
      height: outer.height,
      topInset: inner.top - outer.top,
    };
  }, contentSelector);
}

function expectUniformDensity(rows: VerticalGeometry[]) {
  const insets = rows.flatMap((row) => [row.topInset, row.bottomInset]);
  for (const row of rows) expect(row.height).toBeGreaterThanOrEqual(30);
  for (const inset of insets) expect(inset).toBeGreaterThanOrEqual(5);
  for (const inset of insets) expect(inset).toBeLessThanOrEqual(8);
  expect(Math.max(...insets) - Math.min(...insets)).toBeLessThanOrEqual(2);
}

function intermediateTimeline(): ThreadViewResponse["timeline"] {
  const command = {
    id: "projection-command",
    threadId: "settings-chat",
    turnId: "turn-intermediate",
    itemId: "command",
    itemType: "commandExecution",
    status: "completed",
    codexMethod: "item/completed",
    displayOrder: 1,
    payload: { item: { command: "pwd", output: "/execution/settings", exitCode: 0 } },
  };
  const rows: ThreadTimelineRow[] = [
    {
      id: "activity",
      turnId: "turn-intermediate",
      kind: "activity",
      status: "completed",
      displayOrder: 1,
      items: [command],
    },
    fileChangesRow(2),
  ];
  return {
    activeTurnId: null,
    liveState: "idle",
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    rows,
    turns: [{ id: "turn-intermediate", status: "completed" }],
    viewRevision: 1,
  };
}

function mixedDensityTimeline(): ThreadViewResponse["timeline"] {
  const rows: ThreadTimelineRow[] = [
    {
      id: "context-compacted",
      turnId: "turn-intermediate",
      kind: "context_compaction",
      status: "completed",
      displayOrder: 1,
      item: {
        id: "projection-context-compacted",
        threadId: "settings-chat",
        turnId: "turn-intermediate",
        itemId: "context-compacted",
        itemType: "contextCompaction",
        status: "completed",
        codexMethod: "item/completed",
        displayOrder: 1,
        payload: { item: { type: "contextCompaction" } },
      },
    },
    {
      id: "plan",
      turnId: "turn-intermediate",
      kind: "plan",
      status: "completed",
      displayOrder: 2,
      item: {
        id: "projection-plan",
        threadId: "settings-chat",
        turnId: "turn-intermediate",
        itemId: "plan",
        itemType: "plan",
        status: "completed",
        codexMethod: "item/completed",
        displayOrder: 2,
        payload: { item: { text: "Inspect then patch", type: "plan" } },
      },
    },
  ];
  return {
    activeTurnId: null,
    liveState: "idle",
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    rows,
    turns: [{ id: "turn-intermediate", status: "completed" }],
    viewRevision: 1,
  };
}

function fileChangesRow(displayOrder: number): ThreadTimelineRow {
  return {
    id: "files",
    turnId: "turn-intermediate",
    kind: "file_changes",
    status: "completed",
    displayOrder,
    fileChanges: [
      {
        id: "file-change",
        path: "apps/web/src/timeline/fileRenderers.tsx",
        action: "Modified",
        additions: 3,
        deletions: 1,
        diff: "@@ -1 +1 @@\n-old\n+new",
        itemIds: ["file-change"],
      },
    ],
  };
}

function workBoundaryTimeline(): ThreadViewResponse["timeline"] {
  return {
    activeTurnId: null,
    liveState: "idle",
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    rows: [
      {
        id: "work",
        turnId: "turn-intermediate",
        kind: "work",
        status: "completed",
        displayOrder: 1,
        collapsedRows: [],
        work: { state: "completed", startedAt: 0, completedAt: 1 },
      },
    ],
    turns: [{ id: "turn-intermediate", status: "completed" }],
    viewRevision: 1,
  };
}
