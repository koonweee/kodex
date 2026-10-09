import { expect, test, type Locator, type Page } from "@playwright/test";

import type { components } from "../src/api/generated/schema";
import { nativeSettingsFixture } from "./native-settings.fixture";

const goalPath = "/v1/threads/settings-chat/goal";
const createdGoal: components["schemas"]["ThreadGoal"] = {
  threadId: "settings-chat", objective: "Finish the native migration", status: "active", tokenBudget: 80000,
  tokensUsed: 2400, timeUsedSeconds: 125, createdAt: 1791244800, updatedAt: 1791244925,
};

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("goal slash commands open management and set native goals across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const input = pane(first).getByRole("textbox", { name: "Message composer", exact: true });
        await input.fill("/goal");
        await activate(first.getByRole("option", { name: /\/goal/ }), shape.hasTouch);
        await activate(pane(first).getByRole("button", { name: "Send message", exact: true }), shape.hasTouch);
        const dialog = first.getByRole("dialog", { name: "Goal", exact: true });
        await expect(dialog).toBeVisible();
        expect(mutations(fixture)).toEqual([]);
        await activate(dialog.getByRole("button", { name: "Close goal", exact: true }), shape.hasTouch);
        await input.fill("/goal Verify reconnect convergence");
        await activate(pane(first).getByRole("button", { name: "Send message", exact: true }), shape.hasTouch);
        await expect.poll(() => mutations(fixture)).toEqual([{ objective: "Verify reconnect convergence", status: "active" }]);
        for (const page of [first, second]) await expect(manageGoal(page, "Active")).toBeVisible();
        await expect(input).toHaveValue("");
        await input.fill("/goal");
        await activate(first.getByRole("option", { name: /\/goal/ }), shape.hasTouch);
        await activate(pane(first).getByRole("button", { name: "Send message", exact: true }), shape.hasTouch);
        await expect(dialog.getByRole("textbox", { name: "Objective", exact: true })).toHaveValue("Verify reconnect convergence");
        expect(fixture.requests.filter((entry) => entry.key.startsWith("POST ") && /(?:input|turn|queue)/.test(entry.key))).toEqual([]);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
    test("set, edit, pause, resume, and clear native goals converge across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(pane(page).getByRole("button", { name: "Model: gpt-5.4, medium", exact: true })).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        for (const page of [first, second]) await expect(manageGoal(page)).toHaveCount(0);
        await activate(pane(first).getByRole("button", { name: "Open attachment menu", exact: true }), shape.hasTouch);
        await activate(first.getByRole("menuitem", { name: "Set goal", exact: true }), shape.hasTouch);
        const dialog = first.getByRole("dialog", { name: "Goal", exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("textbox", { name: "Objective", exact: true }).fill(createdGoal.objective);
        await dialog.getByRole("spinbutton", { name: "Token budget", exact: true }).fill("80000");
        await activate(dialog.getByRole("button", { name: "Save goal", exact: true }), shape.hasTouch);
        await expect(dialog).toHaveCount(0);
        for (const page of [first, second]) await expect(manageGoal(page, "Active")).toBeVisible();
        await expect.poll(() => mutations(fixture)).toEqual([{ objective: createdGoal.objective, tokenBudget: 80000 }]);
        await first.screenshot({ path: test.info().outputPath("goal-active.png") });
        await activate(manageGoal(second, "Active"), shape.hasTouch);
        const secondDialog = second.getByRole("dialog", { name: "Goal", exact: true });
        await expect(secondDialog.getByRole("textbox", { name: "Objective", exact: true })).toHaveValue(createdGoal.objective);
        await activate(secondDialog.getByRole("button", { name: "Pause goal", exact: true }), shape.hasTouch);
        for (const page of [first, second]) await expect(manageGoal(page, "Paused")).toBeVisible();
        await expect.poll(() => mutations(fixture).at(-1)).toEqual({ status: "paused" });
        await expect(secondDialog.getByRole("button", { name: "Resume goal", exact: true })).toBeVisible();
        await second.screenshot({ path: test.info().outputPath("goal-modal.png") });
        await secondDialog.getByRole("textbox", { name: "Objective", exact: true }).fill("Ship the completed migration");
        await secondDialog.getByRole("spinbutton", { name: "Token budget", exact: true }).fill("");
        await activate(secondDialog.getByRole("button", { name: "Save goal", exact: true }), shape.hasTouch);
        await expect.poll(() => fixture.goal).toMatchObject({ objective: "Ship the completed migration", status: "paused", tokenBudget: null });
        await expect.poll(() => mutations(fixture).at(-1)).toEqual({ objective: "Ship the completed migration", tokenBudget: null });
        await activate(manageGoal(first, "Paused"), shape.hasTouch);
        await activate(first.getByRole("dialog", { name: "Goal", exact: true }).getByRole("button", { name: "Resume goal", exact: true }), shape.hasTouch);
        for (const page of [first, second]) await expect(manageGoal(page, "Active")).toBeVisible();
        await expect.poll(() => mutations(fixture).at(-1)).toEqual({ status: "active" });
        await activate(first.getByRole("dialog", { name: "Goal", exact: true }).getByRole("button", { name: "Clear goal", exact: true }), shape.hasTouch);
        for (const page of [first, second]) await expect(manageGoal(page)).toHaveCount(0);
        await expect.poll(() => fixture.requests.filter((entry) => entry.key === `DELETE ${goalPath}`).length).toBe(1);
        expect(fixture.goal).toBeNull();
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

test("Stop pauses the native goal and interrupts the turn across tabs with one command", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const stopPath = "/v1/threads/settings-chat/interrupt-current";
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    fixture.setGoal(structuredClone(createdGoal));
    fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: "goal-turn", liveState: "streaming",
      turns: [{ id: "goal-turn", status: "inProgress" }] });
    for (const page of [first, second]) {
      await expect(manageGoal(page, "Active")).toBeVisible();
      await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
    }

    await pane(first).getByRole("button", { name: "Stop turn", exact: true }).click();

    for (const page of [first, second]) {
      await expect(manageGoal(page, "Paused")).toBeVisible();
      await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toHaveCount(0);
      await expect(pane(page).getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    }
    expect(fixture.requests.filter((entry) => entry.key === `POST ${stopPath}`).map((entry) => entry.client)).toEqual(["first"]);
    expect(mutations(fixture)).toEqual([]);
    expect(fixture.goal).toMatchObject({ ...createdGoal, status: "paused" });
    expect(fixture.detail.timeline).toMatchObject({ activeTurnId: null, liveState: "idle", turns: [{ id: "goal-turn", status: "interrupted" }] });
  } finally { await fixture.close(); }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("model-created goals, stale reads, and missed goal events converge without reload", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const reads = (client: string) => fixture.requests.filter((entry) => entry.client === client && entry.key === `GET ${goalPath}`).length;
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    fixture.setGoal(structuredClone(createdGoal));
    for (const page of [first, second]) await expect(manageGoal(page, "Active")).toBeVisible();
    fixture.holdNext("second", "goal");
    fixture.goalChanged("second");
    await expect.poll(() => fixture.isHeld("second", "goal")).toBe(true);
    fixture.setGoal({ ...createdGoal, objective: "Model refined the goal", status: "blocked", tokensUsed: 10000, timeUsedSeconds: 300 });
    for (const page of [first, second]) await expect(manageGoal(page, "Blocked")).toBeVisible();
    await expect.poll(() => fixture.wasAborted("second", "goal")).toBe(true);
    await fixture.release("second", "goal");
    await expect(manageGoal(second, "Blocked")).toBeVisible();
    await manageGoal(second, "Blocked").click();
    const dialog = second.getByRole("dialog", { name: "Goal", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Objective", exact: true })).toHaveValue("Model refined the goal");
    await expect(dialog).toContainText("10,000 / 80,000 tokens");
    await expect(dialog).toContainText("5m 0s");
    await dialog.getByRole("button", { name: "Close goal", exact: true }).click();
    fixture.setGoal({ ...createdGoal, status: "usageLimited" });
    for (const page of [first, second]) await expect(manageGoal(page, "Usage limited")).toBeVisible();
    fixture.setGoal({ ...createdGoal, status: "budgetLimited" });
    for (const page of [first, second]) await expect(manageGoal(page, "Budget limited")).toBeVisible();
    fixture.setGoal({ ...createdGoal, status: "blocked" });
    for (const page of [first, second]) await expect(manageGoal(page, "Blocked")).toBeVisible();
    fixture.setGoal({ ...createdGoal, status: "complete" }, "first");
    await expect(manageGoal(first, "Complete")).toBeVisible();
    await expect(manageGoal(second, "Blocked")).toBeVisible();
    const connections = fixture.connections.get("second") ?? 0;
    const beforeReconnect = reads("second");
    fixture.disconnect("second");
    await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections);
    await expect(manageGoal(second, "Complete")).toBeVisible();
    expect(reads("second")).toBeGreaterThan(beforeReconnect);
    expect(mutations(fixture)).toEqual([]);
    fixture.setGoal(null);
    for (const page of [first, second]) await expect(manageGoal(page)).toHaveCount(0);
  } finally { await fixture.close(); }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

function pane(page: Page) {
  return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
}
function manageGoal(page: Page, status?: string) {
  return pane(page).getByRole("button", { name: status ? `Manage goal: ${status}` : /^Manage goal:/, exact: Boolean(status) });
}
function mutations(fixture: Awaited<ReturnType<typeof nativeSettingsFixture>>) {
  return fixture.requests.filter((entry) => entry.key === `PATCH ${goalPath}`).map((entry) => entry.body);
}

async function activate(locator: Locator, hasTouch: boolean) {
  if (hasTouch) await locator.tap();
  else await locator.click();
}
