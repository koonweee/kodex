import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

const pane = (page: Page) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
const composer = (page: Page) => pane(page).getByRole("textbox", { name: "Message composer", exact: true });

for (const touch of [false, true]) {
  test.describe(touch ? "touch Resume" : "desktop Resume", () => {
    test.use({ viewport: touch ? { width: 390, height: 780 } : { width: 1280, height: 800 }, hasTouch: touch, isMobile: touch });
    test("resumes without a user message, switches to Send while typing, and converges in two tabs", async ({ context }, testInfo) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline.turns = [{ id: "stopped", status: "interrupted" }];
      const resumeBodies: unknown[] = [];
      await context.route("**/v1/threads/settings-chat/resume-turn", async route => {
        const body = route.request().postDataJSON();
        resumeBodies.push(body);
        expect(body).toEqual({ expectedTurnId: "stopped" });
        fixture.publishTimeline({ ...fixture.detail.timeline,
          activeTurnId: "continuation", liveState: "streaming",
          turns: [...fixture.detail.timeline.turns, { id: "continuation", status: "inProgress" }],
        });
        await route.fulfill({ json: { payload: { turn: { id: "continuation", status: "inProgress" } } } });
      });
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        for (const page of [first, second]) await expect(pane(page).getByRole("button", { name: "Resume turn", exact: true })).toBeVisible();
        await first.screenshot({ path: testInfo.outputPath("resume.png") });
        await composer(first).fill("Use this new direction");
        await expect(pane(first).getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        await expect(pane(first).getByRole("button", { name: "Resume turn", exact: true })).toHaveCount(0);
        await expect(pane(second).getByRole("button", { name: "Resume turn", exact: true })).toBeVisible();
        await composer(first).fill("");
        await pane(first).getByRole("button", { name: "Resume turn", exact: true }).click();
        await expect.poll(() => resumeBodies.length).toBe(1);
        for (const page of [first, second]) {
          await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
          await expect(pane(page).getByRole("button", { name: "Resume turn", exact: true })).toHaveCount(0);
          await expect(composer(page)).toHaveValue("");
        }
        expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
        fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: null, liveState: "idle",
          turns: fixture.detail.timeline.turns.map(turn => ({ ...turn, status: "completed" })),
        });
        for (const page of [first, second]) {
          await expect(pane(page).getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
          await expect(pane(page).getByRole("button", { name: "Resume turn", exact: true })).toHaveCount(0);
        }
        fixture.publishTimeline({ ...fixture.detail.timeline,
          turns: [...fixture.detail.timeline.turns, { id: "stopped-again", status: "interrupted" }],
        });
        await expect(pane(first).getByRole("button", { name: "Resume turn", exact: true })).toBeVisible();
        await composer(first).fill("Send a new direction instead");
        await pane(first).getByRole("button", { name: "Send message", exact: true }).click();
        await expect.poll(() => fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input").length).toBe(1);
        expect(fixture.requests.find(request => request.key === "POST /v1/threads/settings-chat/input")?.body).toEqual({
          input: [{ type: "text", text: "Send a new direction instead" }], queueIfPending: true, clientUserMessageId: expect.any(String),
        });
        expect(resumeBodies).toHaveLength(1);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

test("a tab that missed continuation refills after a rejected stale Resume without retrying", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.timeline.turns = [{ id: "stopped", status: "interrupted" }];
  let resumeCalls = 0;
  await context.route("**/v1/threads/settings-chat/resume-turn", async route => {
    resumeCalls += 1;
    await route.fulfill({ status: 409, json: { code: "conflict", message: "The interrupted turn has changed. Refresh before resuming.", retryable: false } });
  });
  try {
    const first = await fixture.page("first");
    const stale = await fixture.page("stale");
    await expect.poll(() => fixture.connected("first") && fixture.connected("stale")).toBe(true);
    for (const page of [first, stale]) await expect(pane(page).getByRole("button", { name: "Resume turn", exact: true })).toBeVisible();
    fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: "newer", liveState: "streaming",
      turns: [...fixture.detail.timeline.turns, { id: "newer", status: "inProgress" }],
    }, "first");
    await expect(pane(first).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
    await pane(stale).getByRole("button", { name: "Resume turn", exact: true }).click();
    await expect(pane(stale).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
    expect(resumeCalls).toBe(1);
    expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual(["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
  expect(fixture.unexpected).toEqual([]);
});
