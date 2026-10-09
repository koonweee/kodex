import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test.use({ viewport: { width: 910, height: 600 } });

test("tab and close-control geometry stays stable across hover and selection with different pane actions", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    await context.route("**/v1/threads/settings-chat/subagents", route => route.fulfill({ json: { subagents: [{
      id: "child", parentThreadId: "settings-chat", agentNickname: "Scout", agentRole: "explorer",
      status: "active", updatedAt: 1777501300, preview: "Working", canAcceptDirectInput: false,
    }] } }));
    const page = await fixture.page("stable-tabs");
    await useSingleTabGroup(page);
    await expect(page.getByRole("button", { name: "Show subagents", exact: true })).toBeVisible();
    const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
    await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
    for (let i = 0; i < 2; i++) {
      await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
      await page.locator('.kodex-thread-pane-empty[data-workspace-pane-active="true"]').getByRole("textbox", { name: /message composer/i }).fill(`Keep draft ${i}`);
    }
    const tabs = page.locator(".dv-tabs-container > .dv-tab");
    await expect(tabs).toHaveCount(3);
    const geometry = () => tabs.evaluateAll(elements => elements.map(el => {
      const tab = el.getBoundingClientRect();
      const close = el.querySelector(".dv-default-tab-action")!.getBoundingClientRect();
      return [tab.x, tab.y, tab.width, tab.height, close.x, close.y, close.width, close.height];
    }));
    const before = await geometry();
    await tabs.filter({ hasText: "Native settings chat" }).hover();
    expect(await geometry()).toEqual(before);
    await tabs.filter({ hasText: "Native settings chat" }).click();
    await expect(page.getByRole("toolbar", { name: "Pane actions" }).getByRole("button").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Show subagents", exact: true })).toBeVisible();
    await expect.poll(geometry).toEqual(before);
    await tabs.last().click();
    await expect(page.getByRole("button", { name: "Show subagents", exact: true })).toBeHidden();
    await expect.poll(geometry).toEqual(before);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("unread and close share a stable slot while native close remains actionable", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("unread-slot");
    await expect.poll(() => fixture.connected("unread-slot")).toBe(true);
    fixture.detail.thread.unreadCompletedAgentTurn = true;
    fixture.refreshRequired();
    const tab = page.locator(".dv-tab:has([data-unread])");
    const dot = tab.locator(".kodex-workspace-pane-title-adornment");
    const close = tab.locator(".dv-default-tab-action");
    await page.mouse.move(800, 500);
    await expect(dot).toHaveCSS("opacity", "1");
    await expect(close).toBeHidden();
    const before = await tab.boundingBox();
    await tab.hover();
    await expect(dot).toHaveCSS("opacity", "0");
    await expect(close).toBeVisible();
    expect(await tab.boundingBox()).toEqual(before);
    const titleBounds = await tab.locator(".dv-default-tab-content").boundingBox();
    const closeBounds = await close.boundingBox();
    expect(titleBounds!.x + titleBounds!.width).toBeGreaterThan(closeBounds!.x + 8);
    await close.click();
    await expect(tab).toHaveCount(0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});


async function useSingleTabGroup(page: Page) {
  // The workspace can now allocate two columns at this viewport. These checks
  // exercise tab-strip behavior, so constrain its allocation and dock as tabs.
  await page.locator(".kodex-workspace-dock").evaluate(el => { el.style.maxWidth = "580px"; });
  await page.locator(".dv-tab").filter({ hasText: "New chat" }).dragTo(
    page.locator(".dv-tab").filter({ hasText: "Native settings chat" }),
  );
  await expect(page.locator(".dv-tabs-container")).toHaveCount(1);
  await page.locator(".dv-tab").filter({ hasText: "Native settings chat" }).click();
}
