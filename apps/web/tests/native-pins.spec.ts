import { expect, test, type Page } from "@playwright/test";

import { executionCwd, nativeProjectsFixture, preservedHistory } from "./native-projects.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("native pin, member order and unpin converge across two tabs", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      fixture.state.threads.push(
        { ...fixture.state.threads[0], id: "second", name: "Second chat", updatedAt: -1, rawPayload: { sectionId: "native-project-custom-section" } },
        { ...fixture.state.threads[0], id: "former-section", name: "Former section chat", projectId: null, rawPayload: { sectionId: "native-custom-section" } },
      );
      try {
        const first = await fixture.page("first", "/threads/history");
        const second = await fixture.page("second", "/threads/history");
        for (const page of [first, second]) await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const initialConnections = new Map(fixture.connections);
        for (const page of [first, second]) {
          const sidebar = await openSidebar(page);
          await expect(sidebar.getByRole("button", { name: "Add section", exact: true })).toHaveCount(0);
          await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
          await expect(sidebar.getByRole("button", { name: "Former section chat", exact: true })).toBeVisible();
          await showProjectThreads(page);
          await expect(sidebar.getByRole("group", { name: "Alpha", exact: true }).getByRole("button", { name: "Second chat", exact: true })).toBeVisible();
        }
        await pinAction(first, "History chat", false, shape.hasTouch);
        await pinAction(first, "Second chat", false, shape.hasTouch);
        await threadMenu(first, "History chat", shape.hasTouch);
        await expect(first.getByRole("menuitem", { name: /section/i })).toHaveCount(0);
        await first.keyboard.press("Escape");
        for (const page of [first, second]) {
          await expectPinnedOrder(page, ["History chat", "Second chat"]);
          const sidebar = await openSidebar(page);
          await expect(sidebar.getByRole("button", { name: "History chat", exact: true })).toHaveCount(1);
          await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
          await expectPinnedOrder(page, ["History chat", "Second chat"]);
        }
        expect(fixture.state.threads.find((entry) => entry.id === "history")).toMatchObject({ projectId: "alpha", cwd: executionCwd });

        // Attention and activity do not replace the native member order.
        Object.assign(fixture.state.threads.find((entry) => entry.id === "second")!, { status: "active", unreadCompletedAgentTurn: true });
        fixture.emit("thread.pins_updated", {});
        for (const page of [first, second]) await expectPinnedOrder(page, ["History chat", "Second chat"]);
        await threadMenu(second, "Second chat", shape.hasTouch);
        const move = second.getByRole("menuitem", { name: "Move up", exact: true });
        if (shape.hasTouch) await move.tap();
        else await move.click();
        for (const page of [first, second]) await expectPinnedOrder(page, ["Second chat", "History chat"]);
        expect(fixture.requests.filter((entry) => entry.key === "POST /v1/threads/second/pin").map((entry) => entry.body)).toEqual([
          { pinned: true }, { pinned: true, beforeThreadId: "history" },
        ]);

        await pinAction(first, "History chat", true, shape.hasTouch);
        for (const page of [first, second]) {
          await expectPinnedOrder(page, ["Second chat"]);
          await showProjectThreads(page);
          const project = (await openSidebar(page)).getByRole("group", { name: "Alpha", exact: true });
          await expect(project.getByRole("button", { name: "History chat", exact: true })).toBeVisible();
          await expect(project.getByRole("button", { name: "Second chat", exact: true })).toHaveCount(0);
        }
        await pinAction(second, "Second chat", true, shape.hasTouch);
        for (const page of [first, second]) {
          await expectPinnedOrder(page, []);
          await showProjectThreads(page);
          await expect((await openSidebar(page)).getByRole("group", { name: "Alpha", exact: true }).getByRole("button", { name: "Second chat", exact: true })).toBeVisible();
        }
        expect(fixture.requests.filter((entry) => entry.key === "POST /v1/threads/history/pin").map((entry) => entry.body)).toEqual([{ pinned: true }, { pinned: false }]);
        expect(fixture.state.threads.every((entry) => !entry.pinned && entry.cwd === executionCwd)).toBe(true);
        expect(fixture.state.threads.find((entry) => entry.id === "former-section")).toMatchObject({ projectId: null, rawPayload: { sectionId: "native-custom-section" } });
        expect(fixture.connections).toEqual(initialConnections);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

test.describe("narrow pinned recovery", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stale snapshots and actual stream reopen recover unlisted native pin order", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    fixture.pinThread("history", true);
    try {
      const first = await fixture.page("first", "/threads/history");
      const second = await fixture.page("second", "/threads/unlisted");
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
      await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
      const initialConnections = new Map(fixture.connections);

      fixture.holdNext("second", "sidebar");
      fixture.holdNext("second", "detail");
      fixture.emit("thread.pins_updated", {}, "second");
      await expect.poll(() => fixture.held.has("second:sidebar") && fixture.held.has("second:detail")).toBe(true);
      expect(fixture.wasAborted("second", "sidebar")).toBe(false);
      fixture.pinThread("unlisted", true);
      fixture.emit("thread.pins_updated", {});
      await expect.poll(() => fixture.wasAborted("second", "sidebar") && fixture.wasAborted("second", "detail")).toBe(true);
      for (const page of [first, second]) await expectPinnedOrder(page, ["History chat", "Unlisted history"]);
      await fixture.release("second", "sidebar");
      await fixture.release("second", "detail");
      await expectPinnedOrder(second, ["History chat", "Unlisted history"]);
      expect(fixture.connections).toEqual(initialConnections);

      // The second tab misses this marker; a real EventSource reopen refills it.
      fixture.pinThread("unlisted", true, "history");
      fixture.emit("thread.pins_updated", {}, "first");
      await expectPinnedOrder(first, ["Unlisted history", "History chat"]);
      await expectPinnedOrder(second, ["History chat", "Unlisted history"]);
      const beforeReconnect = fixture.connections.get("second") ?? 0;
      const reads = () => fixture.requests.filter((entry) => entry.client === "second" && entry.key === "POST /v1/threads/unlisted/attach").length;
      const beforeReads = reads();
      fixture.disconnect("second");
      await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
      await expectPinnedOrder(second, ["Unlisted history", "History chat"]);
      expect(reads()).toBeGreaterThan(beforeReads);
      expect(fixture.state.threads.find((entry) => entry.id === "unlisted")).toMatchObject({ projectId: "alpha", cwd: executionCwd, pinned: true });
      await second.getByRole("button", { name: "Show thread", exact: true }).click();
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
    } finally { await fixture.close(); }
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

async function threadRow(page: Page, title: string, pinned = false) {
  const sidebar = await openSidebar(page);
  const scope = pinned ? sidebar.getByRole("group", { name: "Pinned", exact: true }) : sidebar;
  return scope.locator(".kodex-thread-list-button").filter({ has: page.getByRole("button", { name: title, exact: true }) });
}

async function pinAction(page: Page, title: string, pinned: boolean, touch: boolean) {
  await showProjectThreads(page);
  const row = await threadRow(page, title, pinned);
  if (!touch) await row.hover();
  const action = row.getByRole("button", { name: pinned ? "Unpin thread" : "Pin thread", exact: true });
  if (touch) await action.tap();
  else await action.click();
}

async function threadMenu(page: Page, title: string, touch: boolean) {
  const row = await threadRow(page, title, true);
  if (!touch) await row.hover();
  const action = row.getByRole("button", { name: `Thread actions for ${title}`, exact: true });
  if (touch) await action.tap();
  else await action.click();
}

async function expectPinnedOrder(page: Page, titles: string[]) {
  const group = (await openSidebar(page)).getByRole("group", { name: "Pinned", exact: true });
  await expect(group).toBeVisible();
  await expect.poll(async () => (await group.locator(".kodex-thread-select-button").allTextContents()).map((title) => title.trim())).toEqual(titles);
}
