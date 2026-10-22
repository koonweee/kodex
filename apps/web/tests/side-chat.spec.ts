import { expect, test, type BrowserContext } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

const parentId = "settings-chat";
const sideId = "side-chat";

const summary = (id: string, name: string, parentThreadId: string | null) => ({
  id,
  name,
  parentThreadId,
  canAcceptDirectInput: true,
  projectId: null,
  cwd: "/execution/settings",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  pinned: false,
  preview: name,
  latestCompletedTurnId: null,
  seenCompletedTurnId: null,
  readRevision: 0,
  readStateKnown: false,
  unreadCompletedAgentTurn: false,
  notificationsEnabled: true,
});

const sideResponse = {
  parentThread: summary(parentId, "Native settings chat", null),
  thread: summary(sideId, "Child metadata must not title the tab", parentId),
  liveState: "idle",
  timeline: {
    liveState: "idle",
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    rows: [],
    turns: [],
    viewRevision: 1,
  },
  reused: true,
};

type Fixture = Awaited<ReturnType<typeof nativeSettingsFixture>>;

async function installSideRoutes(context: BrowserContext, fixture: Fixture) {
  const counts = { create: 0, close: 0 };
  await context.route("**/v1/threads/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    if (key === `POST /v1/threads/${parentId}/side-thread`) {
      counts.create += 1;
      return route.fulfill({ json: { ...sideResponse, reused: counts.create > 1 } });
    }
    if (key === `GET /v1/threads/${parentId}/side-thread`) {
      return route.fulfill({ json: sideResponse });
    }
    if (key === `DELETE /v1/threads/${parentId}/side-thread`) {
      counts.close += 1;
      await route.fulfill({ json: { closed: true, sideThreadId: sideId } });
      fixture.sideThreadClosed(parentId, sideId);
      return;
    }
    if (key === `GET /v1/threads/${sideId}/app-surface`) {
      return route.fulfill({ json: { session: null } });
    }
    if (key === `GET /v1/threads/${sideId}/queued-inputs`) {
      return route.fulfill({ json: { queuedInputs: [], transfers: [], nextCursor: null } });
    }
    if (key === `GET /v1/threads/${sideId}/subagents`) {
      return route.fulfill({ json: { subagents: [] } });
    }
    return route.fallback();
  });
  return counts;
}

test("two tabs share, label, restore, and globally close one side chat", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const counts = await installSideRoutes(context, fixture);

  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    for (const page of [first, second]) {
      await page.getByRole("button", { name: "Thread actions" }).click();
      await page.getByRole("menuitem", { name: "Open side chat" }).click();
      await expect(page.getByRole("heading", { name: "> Native settings chat" })).toBeVisible();
      await expect(page.getByLabel("Side chat for “Native settings chat”")).toBeVisible();
    }
    expect(counts.create).toBe(2);

    await first.reload();
    await expect(first.getByRole("heading", { name: "> Native settings chat" })).toBeVisible();
    expect(counts.create).toBe(2);

    const sideTab = first.getByLabel("Side chat for “Native settings chat”");
    await sideTab.hover();
    await sideTab.locator(".dv-default-tab-action").click();
    await expect(first.getByRole("heading", { name: "> Native settings chat" })).toHaveCount(0);
    await expect(second.getByRole("heading", { name: "> Native settings chat" })).toHaveCount(0);
    expect(counts.close).toBe(1);
  } finally {
    await fixture.close();
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const shape of [
  { name: "narrow fine pointer", hasTouch: false, isMobile: false },
  { name: "narrow touch", hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("opens and closes through the normal single-pane chrome", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const counts = await installSideRoutes(context, fixture);
      try {
        const page = await fixture.page(shape.name);
        await page.getByRole("button", { name: "Thread actions" }).click();
        await page.getByRole("menuitem", { name: "Open side chat" }).click();
        await expect(page.getByRole("heading", { name: "> Native settings chat" })).toBeVisible();
        const switcher = page.getByRole("button", { name: "Switch workspace pane" });
        if (shape.hasTouch) await switcher.tap(); else await switcher.click();
        const close = page.getByRole("button", { name: "Close pane > Native settings chat" });
        if (shape.hasTouch) await close.tap(); else await close.click();
        await expect(page.getByRole("heading", { name: "> Native settings chat" })).toHaveCount(0);
        expect(counts.create).toBe(1);
        expect(counts.close).toBe(1);
      } finally {
        await fixture.close();
      }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
