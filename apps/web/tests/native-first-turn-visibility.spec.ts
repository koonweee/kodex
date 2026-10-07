import { expect, test, type Page } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";

for (const projectId of ["alpha", null]) {
  test(`${projectId ? "project" : "standalone"} first-turn titles converge in two tabs before completion`, async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    const thread = fixture.state.threads.find(row => row.id === "history")!;
    Object.assign(thread, { name: null, preview: "", status: "active", projectId });
    fixture.state.hiddenThreadIds.add(thread.id);
    try {
      const first = await fixture.page("first", "/threads/history");
      const second = await fixture.page("second", "/threads/history");
      await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
      for (const page of [first, second]) {
        await openThreads(page, projectId);
        await expect(page.locator(".dv-tab").getByText("New thread", { exact: true })).toBeVisible();
      }
      const connections = new Map(fixture.connections);
      fixture.holdNext("first", "sidebar");
      fixture.emit("thread.summary_changed", { threadId: thread.id }, "first");
      await expect.poll(() => fixture.held.has("first:sidebar")).toBe(true);

      // Native user-item completion makes the DB inventory/preview available.
      // The model is still running; no assistant completion event is delivered.
      fixture.state.hiddenThreadIds.delete(thread.id);
      thread.preview = "Persisted first input";
      fixture.emit("thread.summary_changed", { threadId: thread.id });
      for (const page of [first, second]) await expectTitle(page, "Persisted first input");
      await expect.poll(() => fixture.wasAborted("first", "sidebar")).toBe(true);
      await fixture.release("first", "sidebar");
      for (const page of [first, second]) await expectTitle(page, "Persisted first input");
      expect(fixture.connections).toEqual(connections);

      // A missed marker is recovered by the existing reconnect snapshot; native
      // explicit names keep precedence over the preview in both sidebar and tab.
      thread.name = "Explicit native title";
      fixture.emit("thread.summary_changed", { threadId: thread.id }, "first");
      await expectTitle(first, "Explicit native title");
      fixture.disconnect("second");
      await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections.get("second") ?? 0);
      await expectTitle(second, "Explicit native title");
      await second.reload();
      await openThreads(second, projectId);
      await expectTitle(second, "Explicit native title");
      expect(thread.status).toBe("active");
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

async function openThreads(page: Page, projectId: string | null) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  await sidebar.getByRole("button", { name: projectId ? "Projects" : "Chats", exact: true }).click();
  if (projectId) {
    const expand = sidebar.getByRole("button", { name: "Expand Alpha", exact: true });
    if (await expand.isVisible()) await expand.click();
  }
}

async function expectTitle(page: Page, title: string) {
  const row = page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: title, exact: true });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(page.locator(".dv-tab").getByText(title, { exact: true })).toBeVisible();
}
