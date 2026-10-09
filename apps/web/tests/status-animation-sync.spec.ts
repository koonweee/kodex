import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

// Keep all three thread headers visible under the fixed, non-scrolling tab policy.
test.use({ viewport: { width: 1620, height: 600 } });

async function indicators(page: Page) {
  return page.evaluate(() => document.getAnimations()
    .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation && [
      "kodex-thread-progress-spin", "kodex-unread-agent-turn-pulse",
    ].includes(animation.animationName))
    .map(animation => ({ name: animation.animationName, start: animation.startTime, time: animation.currentTime })));
}

test("late-mounted tabs and sidebar indicators share a clock through state and reduced-motion changes", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.thread.status = "active";
  fixture.detail.timeline.liveState = "streaming";
  fixture.detail.timeline.activeTurnId = "running";
  try {
    const page = await fixture.page("animation-sync");
    await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Chats", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("status", { name: "Thread in progress", exact: true })).toBeVisible();
    for (let i = 0; i < 2; i++) {
      // Deliberately create different mount times; matching mount-time clocks is insufficient.
      await page.waitForTimeout(250);
      await page.getByRole("button", { name: "Thread actions", exact: true }).last().click();
      await page.getByRole("menuitem", { name: "Duplicate pane", exact: true }).click();
    }
    await expect.poll(async () => (await indicators(page)).filter(a => a.name === "kodex-thread-progress-spin").length).toBe(4);
    await expect.poll(async () => (await indicators(page)).every(a => a.start === 0)).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await indicators(page)).length).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await indicators(page)).filter(a => a.name === "kodex-thread-progress-spin").length).toBe(4);
    await expect.poll(async () => (await indicators(page)).every(a => a.start === 0)).toBe(true);
    fixture.detail.thread.status = "idle";
    fixture.detail.thread.unreadCompletedAgentTurn = true;
    fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: null, liveState: "idle" });
    fixture.refreshRequired();
    await expect.poll(async () => (await indicators(page)).filter(a => a.name === "kodex-unread-agent-turn-pulse").length).toBe(4);
    await expect.poll(async () => new Set((await indicators(page)).map(a => a.time)).size).toBe(1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await indicators(page)).length).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(async () => (await indicators(page)).length).toBe(4);
    await expect.poll(async () => (await indicators(page)).every(a => a.start === 0)).toBe(true);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
