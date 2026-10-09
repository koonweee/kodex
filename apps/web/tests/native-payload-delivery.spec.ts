import { expect, test, type Page } from "@playwright/test";
import type { ThreadTimelineRow, ThreadViewResponse } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

// Two tabs on one authoritative thread choose their own optional delivery details.
test("payload toggles change subsequent delivery without refilling either tab", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context, { payloadDelivery: true });
  fixture.detail.timeline = timeline("BEFORE_ENABLE_OUTPUT", "BEFORE_ENABLE_DEBUG", 1);
  fixture.detail.historyPage = { olderCursor: "older", hasOlder: true, limit: 50, loadedTurnCount: 1 };
  const successfulAttaches = new Map<Page, number>();
  context.on("response", async response => {
    if (new URL(response.url()).pathname !== "/v1/threads/settings-chat/attach" || response.status() !== 200) return;
    if (await response.finished() || response.request().failure()) return;
    const page = response.frame().page();
    successfulAttaches.set(page, (successfulAttaches.get(page) ?? 0) + 1);
  });
  const reads = () => fixture.requests.filter(request => /\/settings-chat(?:\/attach|\/timeline\/pages)?$/.test(new URL(request.url).pathname));
  const latestStream = (client: string) => new URL(fixture.streamRequests.filter(request => request.client === client).at(-1)!.url);
  try {
    const first = await fixture.page("enabled");
    const second = await fixture.page("disabled");
    for (const page of [first, second]) {
      await expect.poll(() => successfulAttaches.get(page) ?? 0).toBeGreaterThanOrEqual(1);
      await openCommand(page);
      await expect(page.locator(".kodex-command-panel")).toContainText("$ pwd");
      await expect(page.locator(".kodex-activity-status")).toHaveText("Success");
      await expect(page.locator(".kodex-timeline-output")).toHaveCount(0);
      await expect(page.getByText("Hidden debug events", { exact: true })).toHaveCount(0);
    }
    await expect.poll(() => fixture.connected("enabled") && fixture.connected("disabled")).toBe(true);
    for (const [page, client] of [[first, "enabled"], [second, "disabled"]] as const) {
      await expect.poll(() => successfulAttaches.get(page) ?? 0).toBe(fixture.requests.filter(request => request.client === client && request.key.endsWith("/attach") && request.failure() !== "net::ERR_ABORTED").length);
    }
    const initialReads = reads().length;

    // Give the stream a nonzero cursor before reopening it for the preferences.
    fixture.publishTimeline(timeline("BEFORE_ENABLE_OUTPUT", "BEFORE_ENABLE_DEBUG", 2));
    const expectedCursor = fixture.detail.timeline.viewRevision + 1;
    await expect.poll(() => first.evaluate(() => window.__KODEX_LIVE_DIAGNOSTICS__?.().eventsByStreamAndKind["global:turn_queue.changed"] ?? 0)).toBeGreaterThan(0);
    await setToggle(first, "Show debug events", true);
    await setToggle(first, "Show command outputs", true);
    await expect.poll(() => latestStream("enabled").searchParams.get("includeDebugEvents")).toBe("true");
    await expect.poll(() => latestStream("enabled").searchParams.get("includeCommandOutputs")).toBe("true");
    expect(Number(latestStream("enabled").searchParams.get("cursor"))).toBe(expectedCursor);
    expect(latestStream("disabled").searchParams.get("includeDebugEvents")).not.toBe("true");
    expect(latestStream("disabled").searchParams.get("includeCommandOutputs")).not.toBe("true");
    expect(reads()).toHaveLength(initialReads);
    await expect(first.locator(".kodex-timeline-output")).toHaveCount(0);
    await expect(first.getByText("BEFORE_ENABLE_DEBUG", { exact: true })).toHaveCount(0);

    fixture.publishTimeline(timeline("SUBSEQUENT_OUTPUT", "SUBSEQUENT_DEBUG", 3));
    await expect(first.locator(".kodex-timeline-output")).toHaveText("SUBSEQUENT_OUTPUT");
    await first.getByText("Hidden debug events", { exact: true }).click();
    await expect(first.getByText("SUBSEQUENT_DEBUG", { exact: true })).toBeVisible();
    await expect(second.locator(".kodex-timeline-output")).toHaveCount(0);
    await expect(second.getByText("SUBSEQUENT_DEBUG", { exact: true })).toHaveCount(0);
    expect(reads()).toHaveLength(initialReads);
    await first.screenshot({ path: "/tmp/kodex-payload-delivery-on.png" });

    // An ordinary history read includes details with the current preferences.
    await first.getByRole("button", { name: "Load older history", exact: true }).click();
    const history = fixture.requests.find(request => request.key === "GET /v1/threads/settings-chat/timeline/pages")!;
    expect(new URL(history.url).searchParams.get("includeDebugEvents")).toBe("true");
    expect(new URL(history.url).searchParams.get("includeCommandOutputs")).toBe("true");
    await expect(first.locator(".kodex-timeline-output")).toHaveText("SUBSEQUENT_OUTPUT");
    const afterHistory = reads().length;

    await setToggle(first, "Show command outputs", false);
    await expect.poll(() => latestStream("enabled").searchParams.get("includeCommandOutputs") === "true").toBe(false);
    await expect(first.locator(".kodex-timeline-output")).toHaveCount(0);
    await expect(first.getByText("SUBSEQUENT_DEBUG", { exact: true })).toBeVisible();
    fixture.publishTimeline(timeline("DEBUG_ONLY_OUTPUT", "DEBUG_ONLY_DEBUG", 4));
    await expect(first.getByText("DEBUG_ONLY_DEBUG", { exact: true })).toBeVisible();
    await expect(first.locator(".kodex-timeline-output")).toHaveCount(0);
    expect(reads()).toHaveLength(afterHistory);

    await setToggle(first, "Show debug events", false);
    await expect.poll(() => latestStream("enabled").searchParams.get("includeDebugEvents") === "true").toBe(false);
    await setToggle(first, "Show command outputs", true);
    await expect.poll(() => latestStream("enabled").searchParams.get("includeCommandOutputs")).toBe("true");
    await expect(first.locator(".kodex-timeline-output")).toHaveCount(0);
    fixture.publishTimeline(timeline("OUTPUT_ONLY_OUTPUT", "OUTPUT_ONLY_DEBUG", 6));
    await expect(first.locator(".kodex-timeline-output")).toHaveText("OUTPUT_ONLY_OUTPUT");
    await expect(first.getByText("Hidden debug events", { exact: true })).toHaveCount(0);
    await expect(second.locator(".kodex-timeline-output")).toHaveCount(0);
    expect(reads()).toHaveLength(afterHistory);
    await setToggle(first, "Show command outputs", false);
    await expect(first.getByText("Hidden debug events", { exact: true })).toHaveCount(0);
    await expect.poll(() => latestStream("enabled").searchParams.get("includeCommandOutputs") === "true").toBe(false);
    await expect.poll(() => latestStream("enabled").searchParams.get("includeDebugEvents") === "true").toBe(false);
    await expect.poll(() => fixture.connected("enabled")).toBe(true);
    expect(reads()).toHaveLength(afterHistory);

    // Missed events recover normally; both tabs still request the compact projection.
    fixture.detail.timeline = timeline("RECOVERY_OUTPUT", "RECOVERY_DEBUG", 8);
    const connectionCount = fixture.connections.get("enabled") ?? 0;
    fixture.disconnect("enabled");
    await expect.poll(() => fixture.connections.get("enabled") ?? 0).toBeGreaterThan(connectionCount);
    await expect.poll(() => reads().length).toBeGreaterThan(afterHistory);
    const recovery = fixture.requests.filter(request => request.client === "enabled" && request.key === "POST /v1/threads/settings-chat/attach").at(-1)!;
    expect(new URL(recovery.url).searchParams.get("includeDebugEvents")).not.toBe("true");
    expect(new URL(recovery.url).searchParams.get("includeCommandOutputs")).not.toBe("true");
    await expect(first.locator(".kodex-command-panel")).toContainText("$ pwd");
    await expect(first.locator(".kodex-timeline-output")).toHaveCount(0);
    await expect(first.getByText("Hidden debug events", { exact: true })).toHaveCount(0);
    await expect(second.locator(".kodex-command-panel")).toContainText("$ pwd");
    await first.screenshot({ path: "/tmp/kodex-payload-delivery-off.png" });
  } finally {
    await fixture.close();
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function setToggle(page: Page, name: string, checked: boolean) {
  await page.getByRole("button", { name: "Account settings", exact: true }).click();
  const control = page.getByRole("menuitemcheckbox", { name, exact: true });
  await expect(control).toHaveAttribute("aria-checked", String(!checked));
  await control.click();
  await expect(control).toHaveAttribute("aria-checked", String(checked));
  await page.keyboard.press("Escape");
}

async function openCommand(page: Page) {
  await page.locator(".kodex-activity-group > summary").click();
  await page.locator(".kodex-activity-item > summary").click();
}

function timeline(output: string, debug: string, viewRevision: number): ThreadViewResponse["timeline"] {
  const item = (id: string, itemType: string, body: Record<string, unknown>, displayOrder: number) => ({
    id: `projection-${id}`, threadId: "settings-chat", turnId: "turn-command", itemId: id, itemType,
    status: "completed", codexMethod: "item/completed", displayOrder, payload: { item: body },
  });
  const rows: ThreadTimelineRow[] = [
    { id: "commands", turnId: "turn-command", kind: "activity", status: "completed", displayOrder: 1,
      items: [item("command", "commandExecution", { command: "pwd", output, exitCode: 0 }, 1)] },
    { id: "debug", turnId: "turn-command", kind: "fixtureDebug", status: "completed", displayOrder: 2,
      item: item("debug", "fixtureDebug", { text: debug }, 2) },
  ];
  return { activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [],
    viewRevision, rows, turns: [{ id: "turn-command", status: "completed" }] };
}
