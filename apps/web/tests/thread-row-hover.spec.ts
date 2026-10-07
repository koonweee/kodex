import { expect, test, type Locator } from "@playwright/test";
import { nativeProjectsFixture, preservedHistory } from "./native-projects.fixture";

const states = ["idle", "unread", "active"] as const;

for (const shape of [
  { name: "expanded desktop sidebar", width: 1280, peek: false },
  { name: "hover sidebar", width: 1280, peek: true },
  { name: "narrow fine pointer sidebar", width: 390, peek: false },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: false, isMobile: false });
    test("keeps row heights, neighboring rows, titles and controls in place on hover and focus", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      const base = fixture.state.threads[0];
      for (const section of ["Pinned", "Project", "Chat"]) {
        for (const state of states) {
          const id = `${section}-${state}`;
          fixture.state.threads.push({
            ...base, id, name: `${section} ${state} with a long title that must stay consistently truncated`,
            projectId: section === "Chat" ? null : "alpha", status: state === "active" ? "active" : "idle",
            unreadCompletedAgentTurn: state === "unread",
          });
          if (section === "Pinned") fixture.pinThread(id, true);
        }
      }
      try {
        const page = await fixture.page("geometry", "/threads/history");
        await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        if (shape.width < 768) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        if (shape.peek) {
          await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).click();
          await page.mouse.move(1100, 700);
          await page.getByRole("button", { name: "Expand workspace sidebar", exact: true }).hover();
          await expect(page.locator(".kodex-sidebar-peek-panel")).toBeVisible();
        }
        const sidebar = shape.peek ? page.locator(".kodex-sidebar-peek-panel") : page.getByRole("navigation", { name: "Workspace", exact: true });
        const project = sidebar.getByRole("group", { name: "Alpha", exact: true });
        const expand = project.getByRole("button", { name: "Expand Alpha", exact: true });
        if (await expand.count()) await expand.click();
        for (const section of ["Pinned", "Project", "Chat"]) {
          if (section === "Chat") await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
          for (const state of states) {
            const name = `${section} ${state} with a long title that must stay consistently truncated`;
            const button = sidebar.getByRole("button", { name, exact: true });
            const row = button.locator("..");
            await expect(button).toBeVisible();
            // Keep the peek open while moving away from the thread row.
            const outsideRow = sidebar.getByRole("button", { name: section === "Chat" ? "Chats" : "Projects", exact: true });
            await outsideRow.hover();
            await button.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
            const before = await geometry(row);
            const archive = row.getByRole("button", { name: `Archive ${name}`, exact: true });
            await expect(archive).toHaveCount(0);
            await button.hover();
            await expect(archive).toBeVisible();
            await expect.poll(() => geometry(row)).toEqual(before);
            if (state === "active") await expect(row.getByRole("status", { name: "Thread in progress", exact: true })).toHaveCount(0);
            if (state === "unread") await expect(row.getByRole("img", { name: "Unread completed agent turn", exact: true })).toHaveCount(0);
            await outsideRow.hover();
            await expect(archive).toHaveCount(0);
            await expect.poll(() => geometry(row)).toEqual(before);
            if (state === "active") await expect(row.getByRole("status", { name: "Thread in progress", exact: true })).toBeVisible();
            if (state === "unread") await expect(row.getByRole("img", { name: "Unread completed agent turn", exact: true })).toBeVisible();
            await button.focus();
            await expect(archive).toBeVisible();
            await expect.poll(() => geometry(row)).toEqual(before);
            await button.evaluate((element) => (element as HTMLButtonElement).blur());
            await expect(archive).toHaveCount(0);
          }
        }
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}

async function geometry(row: Locator) {
  return row.evaluate((element) => {
    function rectangle(target: Element | null) {
      if (!target) return null;
      const { x, y, width, height } = target.getBoundingClientRect();
      return { x, y, width, height };
    }
    return {
      row: rectangle(element),
      nextSibling: rectangle(element.nextElementSibling),
      controls: [
        ".kodex-thread-select-button", ".kodex-thread-list-title", ".kodex-sidebar-row-leading", ".kodex-sidebar-row-trailing",
        '[aria-label^="Thread actions for"]',
      ].map((selector) => rectangle(element.querySelector(selector))),
    };
  });
}
