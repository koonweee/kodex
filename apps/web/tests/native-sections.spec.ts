import { expect, test, type Page } from "@playwright/test";

import { executionCwd, nativeProjectsFixture, pinnedSectionId, preservedHistory } from "./native-projects.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("native section edits, member order and pin moves converge in two tabs", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      fixture.state.threads.push({ ...fixture.state.threads[0], id: "second", name: "Second chat", updatedAt: -1 });
      try {
        const first = await fixture.page("first", "/threads/history");
        const second = await fixture.page("second", "/threads/history");
        for (const page of [first, second]) await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const initialConnections = new Map(fixture.connections);

        const sidebar = await openSidebar(first);
        await sidebar.getByRole("button", { name: "Add section", exact: true }).click();
        const create = first.getByRole("dialog");
        await create.getByRole("textbox", { name: "Section name", exact: true }).fill("Research");
        await create.getByRole("button", { name: "Create section", exact: true }).click();
        await expect(create).toHaveCount(0);
        await expect.poll(() => fixture.requests.filter((entry) => entry.key === "POST /v1/thread-sections").map((entry) => entry.body)).toEqual([{ name: "Research" }]);
        for (const page of [first, second]) await expect((await openSidebar(page)).getByRole("group", { name: "Research section", exact: true })).toBeVisible();
        const createdId = fixture.state.sections.find((section) => section.name === "Research")!.id;

        // Sections are native organization across both sidebar scopes.
        for (const page of [first, second]) {
          const sidebar = await openSidebar(page);
          await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
          await expect(sidebar.getByRole("group", { name: "Research section", exact: true })).toBeVisible();
        }

        await moveTo(first, "History chat", "Research", shape.hasTouch);
        await moveTo(first, "Second chat", "Research", shape.hasTouch);
        for (const page of [first, second]) await expectSectionOrder(page, "Research", ["History chat", "Second chat"]);
        expect(fixture.state.threads.find((entry) => entry.id === "history")).toMatchObject({ projectId: "alpha", cwd: executionCwd });

        // Native order survives attention changes; it is not reconstructed from
        // observed status, unread counters, section timestamps or recency.
        Object.assign(fixture.state.threads.find((entry) => entry.id === "second")!, { status: "active", unreadCompletedAgentTurn: true });
        fixture.emit("thread.sections_updated", {});
        for (const page of [first, second]) await expectSectionOrder(page, "Research", ["History chat", "Second chat"]);
        await threadMenu(second, "Second chat", shape.hasTouch);
        await second.getByRole("menuitem", { name: "Move up", exact: true }).click();
        for (const page of [first, second]) await expectSectionOrder(page, "Research", ["Second chat", "History chat"]);
        expect(fixture.requests.filter((entry) => entry.key === "POST /v1/threads/second/section").map((entry) => entry.body)).toEqual([
          { sectionId: createdId }, { sectionId: createdId, beforeThreadId: "history" },
        ]);

        // Rename is sparse, preserving native appearance not edited by this UI.
        fixture.state.sections.find((section) => section.id === createdId)!.appearance = { icon: "opaque-native-icon", color: "opaque-native-color" };
        fixture.emit("thread.sections_updated", {});
        await (await openSidebar(first)).getByRole("button", { name: "Section actions for Research", exact: true }).click();
        await first.getByRole("menuitem", { name: "Rename section", exact: true }).click();
        const rename = first.getByRole("dialog");
        await rename.getByRole("textbox", { name: "Section name", exact: true }).fill("Renamed research");
        await rename.getByRole("button", { name: "Save section", exact: true }).click();
        for (const page of [first, second]) await expectSectionOrder(page, "Renamed research", ["Second chat", "History chat"]);
        expect(fixture.requests.filter((entry) => entry.key === `PATCH /v1/thread-sections/${createdId}`).map((entry) => entry.body)).toEqual([{ name: "Renamed research" }]);
        expect(fixture.state.sections.find((section) => section.id === createdId)?.appearance).toEqual({ icon: "opaque-native-icon", color: "opaque-native-color" });

        await moveTo(first, "History chat", "Pinned", shape.hasTouch);
        for (const page of [first, second]) {
          await expectSectionOrder(page, "Pinned", ["History chat"]);
          await expectSectionOrder(page, "Renamed research", ["Second chat"]);
        }
        await moveTo(first, "History chat", "No section", shape.hasTouch);
        expect(fixture.requests.filter((entry) => entry.key === "POST /v1/threads/history/section").map((entry) => entry.body)).toEqual([
          { sectionId: createdId }, { sectionId: pinnedSectionId }, { sectionId: null },
        ]);
        expect(fixture.state.threads.find((entry) => entry.id === "history")?.section).toBeNull();
        for (const page of [first, second]) {
          await expectSectionOrder(page, "Pinned", []);
          await expectSectionOrder(page, "Renamed research", ["Second chat"]);
          await showProjectThreads(page);
          await expect((await openSidebar(page)).getByRole("group", { name: "Alpha", exact: true }).getByRole("button", { name: "History chat", exact: true })).toBeVisible();
        }
        expect(fixture.connections).toEqual(initialConnections);

        await (await openSidebar(first)).getByRole("button", { name: "Section actions for Renamed research", exact: true }).click();
        await first.getByRole("menuitem", { name: "Delete section", exact: true }).click();
        const confirm = first.getByRole("dialog");
        await confirm.getByRole("button", { name: "Delete section", exact: true }).click();
        for (const page of [first, second]) {
          const sidebar = await openSidebar(page);
          await expect(sidebar.getByRole("group", { name: "Renamed research section", exact: true })).toHaveCount(0);
          await showProjectThreads(page);
          await expect(sidebar.getByRole("button", { name: "Second chat", exact: true })).toBeVisible();
        }
        expect(fixture.state.threads).toHaveLength(3);
        expect(fixture.state.threads.find((entry) => entry.id === "second")).toMatchObject({ projectId: "alpha", cwd: executionCwd, section: null });
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

test.describe("narrow section recovery", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stale snapshots and actual stream reopen recover unlisted native membership", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    fixture.state.sections.push({ id: "research", name: "Research", appearance: null });
    fixture.moveThread("history", "research");
    try {
      const first = await fixture.page("first", "/threads/history");
      const second = await fixture.page("second", "/threads/unlisted");
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
      await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
      const initialConnections = new Map(fixture.connections);

      fixture.holdNext("second", "sidebar");
      fixture.holdNext("second", "detail");
      fixture.emit("thread.sections_updated", {}, "second");
      await expect.poll(() => fixture.held.has("second:sidebar") && fixture.held.has("second:detail")).toBe(true);
      expect(fixture.wasAborted("second", "sidebar")).toBe(false);
      fixture.moveThread("unlisted", pinnedSectionId);
      fixture.emit("thread.sections_updated", {});
      await expect.poll(() => fixture.wasAborted("second", "sidebar") && fixture.wasAborted("second", "detail")).toBe(true);
      for (const page of [first, second]) await expectSectionOrder(page, "Pinned", ["Unlisted history"]);
      await fixture.release("second", "sidebar");
      await fixture.release("second", "detail");
      await expectSectionOrder(second, "Pinned", ["Unlisted history"]);
      expect(fixture.connections).toEqual(initialConnections);

      // The second tab misses this marker, so only real EventSource reopening
      // may recover the native membership. No page reload or forced callback.
      fixture.moveThread("unlisted", "research");
      fixture.emit("thread.sections_updated", {}, "first");
      await expectSectionOrder(first, "Research", ["History chat", "Unlisted history"]);
      await expectSectionOrder(second, "Pinned", ["Unlisted history"]);
      const beforeReconnect = fixture.connections.get("second") ?? 0;
      const reads = () => fixture.requests.filter((entry) => entry.client === "second" && entry.key === "GET /v1/threads/unlisted").length;
      const beforeReads = reads();
      fixture.disconnect("second");
      await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
      await expectSectionOrder(second, "Research", ["History chat", "Unlisted history"]);
      expect(reads()).toBeGreaterThan(beforeReads);
      expect(fixture.state.threads.find((entry) => entry.id === "unlisted")).toMatchObject({ projectId: "alpha", cwd: executionCwd });
      await second.getByRole("button", { name: "Show thread", exact: true }).click();
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
    } finally {
      await fixture.close();
    }
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
});

async function openSidebar(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function showProjectThreads(page: Page) {
  const sidebar = await openSidebar(page);
  const projects = sidebar.getByRole("button", { name: "Projects", exact: true });
  if (await projects.getAttribute("aria-pressed") === "false") await projects.click();
  const expand = sidebar.getByRole("button", { name: "Expand Alpha", exact: true });
  if (await expand.isVisible()) await expand.click();
}

async function threadMenu(page: Page, title: string, touch: boolean) {
  await showProjectThreads(page);
  const sidebar = await openSidebar(page);
  if (!touch) await sidebar.getByRole("button", { name: title, exact: true }).hover();
  const actions = sidebar.getByRole("button", { name: `Thread actions for ${title}`, exact: true });
  if (touch) await actions.tap();
  else await actions.click();
}

async function moveTo(page: Page, title: string, section: string, touch: boolean) {
  await threadMenu(page, title, touch);
  const destination = page.getByRole("menuitem", { name: section, exact: true });
  if (touch) await destination.tap();
  else await destination.click();
}

async function expectSectionOrder(page: Page, name: string, titles: string[]) {
  const group = (await openSidebar(page)).getByRole("group", { name: `${name} section`, exact: true });
  await expect(group).toBeVisible();
  await expect.poll(async () => (await group.locator(".kodex-thread-select-button").allTextContents()).map((title) => title.trim())).toEqual(titles);
}
