import { expect, test, type Page } from "@playwright/test";

import { executionCwd, nativeProjectsFixture, preservedHistory } from "./native-projects.fixture";

const shapes = [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
];

for (const shape of shapes) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("native project edits, ordering and chat membership converge across two tabs", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      try {
        const first = await fixture.page("first", "/threads/history");
        const second = await fixture.page("second", "/threads/history");
        for (const page of [first, second]) {
          await expect(page.getByRole("button", { name: "Chat project: Alpha", exact: true })).toBeVisible();
          await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        }
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const secondConnections = fixture.connections.get("second");

        // Native accepts the first intent, but its reply is lost. Retry must use the
        // same key and receive that existing project, without a duplicate registry row.
        fixture.failNextCreateReply();
        await openSidebar(first);
        await first.getByRole("button", { name: "Add project", exact: true }).click();
        const create = first.getByRole("dialog", { name: "Add project", exact: true });
        await create.getByRole("textbox", { name: "Project name", exact: true }).fill("Research");
        await create.getByRole("textbox", { name: "Root directories", exact: true }).fill("/repos/one\n/repos/two");
        await create.getByRole("button", { name: "Add project", exact: true }).click();
        await expect(create.getByText("Create reply lost; retry this intent.")).toBeVisible();
        await create.getByRole("button", { name: "Add project", exact: true }).click();
        await expect(create).toHaveCount(0);
        const createRequests = fixture.requests.filter((entry) => entry.key === "POST /v1/projects");
        expect(createRequests).toHaveLength(2);
        expect(createRequests[0].body).toEqual({ name: "Research", roots: [{ path: "/repos/one" }, { path: "/repos/two" }], idempotencyKey: expect.any(String) });
        expect(createRequests[1].body).toEqual(createRequests[0].body);
        expect(fixture.state.projects.filter((entry) => entry.name === "Research")).toHaveLength(1);
        await expect(first.getByRole("textbox", { name: "Working directory", exact: true })).toHaveValue("");

        // Another native client writes metadata Kodex does not expose in its form.
        fixture.state.projects.find((entry) => entry.id === "created-1")!.metadata = { owner: "another-native-client" };
        fixture.emit("project.changed", { projectId: "created-1", changeType: "updated" });
        await openProjectSettings(first, "Research", shape.hasTouch);
        await first.getByRole("textbox", { name: "Project name", exact: true }).fill("Renamed research");
        await first.getByRole("button", { name: "Save project", exact: true }).click();
        await expect(first.getByRole("heading", { name: "Renamed research", exact: true })).toBeVisible();
        expect(fixture.requests.filter((entry) => entry.key === "PATCH /v1/projects/created-1").map((entry) => entry.body)).toEqual([{ name: "Renamed research" }]);
        expect(fixture.state.projects.find((entry) => entry.id === "created-1")).toMatchObject({
          roots: [{ path: "/repos/one" }, { path: "/repos/two" }], metadata: { owner: "another-native-client" },
        });

        await first.getByRole("textbox", { name: "Move before", exact: true }).click();
        await first.getByRole("option", { name: "Alpha", exact: true }).click();
        await first.getByRole("button", { name: "Move project", exact: true }).click();
        await expect.poll(() => fixture.requests.filter((entry) => entry.key === "POST /v1/projects/created-1/move").map((entry) => entry.body)).toEqual([{ beforeProjectId: "alpha" }]);
        for (const page of [first, second]) {
          const sidebar = await openSidebar(page);
          await expect.poll(() => sidebar.getByRole("group", { name: /^(Alpha|Beta|Renamed research)$/ }).evaluateAll((groups) => groups.map((group) => group.getAttribute("aria-label")))).toEqual(["Renamed research", "Alpha", "Beta"]);
          await openHistory(page);
        }
        expect(fixture.connections.get("second")).toBe(secondConnections);

        await second.getByRole("button", { name: "Chat project: Alpha", exact: true }).click();
        await second.getByRole("menuitem", { name: "Beta", exact: true }).click();
        for (const page of [first, second]) await expect(page.getByRole("button", { name: "Chat project: Beta", exact: true })).toBeVisible();
        await first.getByRole("button", { name: "Chat project: Beta", exact: true }).click();
        await first.getByRole("menuitem", { name: "No project", exact: true }).click();
        for (const page of [first, second]) {
          await expect(page.getByRole("button", { name: "Chat project: No project", exact: true })).toBeVisible();
          await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        }
        expect(fixture.requests.filter((entry) => entry.key === "PATCH /v1/threads/history/project").map((entry) => entry.body)).toEqual([{ projectId: "beta" }, { projectId: null }]);
        expect(fixture.state.threads.find((entry) => entry.id === "history")?.cwd).toBe(executionCwd);
        expect(fixture.requests.some((entry) => /\/v1\/threads\/[^/]+$/.test(entry.key) && entry.key.startsWith("DELETE"))).toBe(false);
        expect(fixture.expectedCreateErrors).toHaveLength(1);
        expect(fixture.unexpected).toEqual([]);
        expect(fixture.errors).toEqual([]);
      } finally {
        await fixture.close();
      }
    });
  });
}

test.describe("narrow detail recovery", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("deletion and real stream reopen recover unlisted membership without stale responses winning", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    try {
      const first = await fixture.page("first", "/projects/alpha");
      const second = await fixture.page("second", "/threads/unlisted");
      await expect(first.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
      await expect(second.getByRole("button", { name: "Chat project: Alpha", exact: true })).toBeVisible();
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
      await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);

      // This unlisted chat is absent from every sidebar bucket. Both pending reads
      // capture old membership before project deletion; neither may restore it.
      fixture.holdNext("second", "sidebar");
      fixture.holdNext("second", "detail");
      fixture.emit("thread.project_updated", { threadId: "unlisted", projectId: "alpha" }, "second");
      await expect.poll(() => fixture.held.has("second:sidebar") && fixture.held.has("second:detail")).toBe(true);
      expect(fixture.wasAborted("second", "sidebar")).toBe(false);
      expect(fixture.wasAborted("second", "detail")).toBe(false);
      await first.getByRole("button", { name: "Delete project", exact: true }).click();
      const confirm = first.getByRole("dialog", { name: "Delete Alpha?", exact: true });
      await expect(confirm.getByText("Its chats will remain available without a project. Files are unchanged.")).toBeVisible();
      await confirm.getByRole("button", { name: "Delete project", exact: true }).click();
      await expect(second.getByRole("button", { name: "Chat project: No project", exact: true })).toBeVisible();
      await expect.poll(() => fixture.wasAborted("second", "sidebar") && fixture.wasAborted("second", "detail")).toBe(true);
      await fixture.release("second", "sidebar");
      await fixture.release("second", "detail");
      await expect(second.getByRole("button", { name: "Chat project: No project", exact: true })).toBeVisible();
      const sidebar = await openSidebar(second);
      await expect(sidebar.getByRole("group", { name: "Alpha", exact: true })).toHaveCount(0);
      await expect(sidebar.getByRole("button", { name: "Unlisted history", exact: true })).toHaveCount(0);
      // Close the mobile sidebar without navigating or reloading the unlisted chat.
      await second.getByRole("button", { name: "Show thread", exact: true }).click();
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
      expect(fixture.state.threads).toHaveLength(2);
      expect(fixture.state.threads.every((entry) => entry.projectId === null && entry.cwd === executionCwd)).toBe(true);

      const beforeReconnect = fixture.connections.get("second") ?? 0;
      const readsBeforeReconnect = fixture.requests.filter((entry) => entry.client === "second" && entry.key === "POST /v1/threads/unlisted/attach").length;
      fixture.state.projects[0].name = "Recovered Beta";
      fixture.state.threads.find((entry) => entry.id === "unlisted")!.projectId = "beta";
      fixture.emit("project.changed", { projectId: "beta", changeType: "updated" }, "first");
      fixture.emit("thread.project_updated", { threadId: "unlisted", projectId: "beta" }, "first");
      await expect(second.getByRole("button", { name: "Chat project: No project", exact: true })).toBeVisible();
      fixture.disconnect("second");
      await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
      await expect(second.getByRole("button", { name: "Chat project: Recovered Beta", exact: true })).toBeVisible();
      await expect(second.getByText(preservedHistory, { exact: true })).toBeVisible();
      expect(fixture.requests.filter((entry) => entry.client === "second" && entry.key === "POST /v1/threads/unlisted/attach").length).toBeGreaterThan(readsBeforeReconnect);
      expect(fixture.state.threads.find((entry) => entry.id === "unlisted")?.cwd).toBe(executionCwd);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

async function openSidebar(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function openProjectSettings(page: Page, name: string, touch: boolean) {
  const sidebar = await openSidebar(page);
  const group = sidebar.getByRole("group", { name, exact: true });
  if (!touch) await group.hover();
  await group.getByRole("button", { name: `Project settings for ${name}`, exact: true }).click();
}

async function openHistory(page: Page) {
  const sidebar = await openSidebar(page);
  const expand = sidebar.getByRole("button", { name: "Expand Alpha", exact: true });
  if (await expand.isVisible()) await expand.click();
  await sidebar.getByRole("button", { name: "History chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Chat project: Alpha", exact: true })).toBeVisible();
}
