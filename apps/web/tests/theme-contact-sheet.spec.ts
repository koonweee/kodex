import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { KODEX_COLOR_SCHEMES } from "../src/themeRegistry";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";
import { measureTheme } from "./theme-contrast.measure";

// Opt-in diagnostic capture; no visual golden files in the routine suite.
const output = process.env.KODEX_THEME_AUDIT_DIR;
test.skip(!output, "Set KODEX_THEME_AUDIT_DIR to generate captures");
for (const scheme of KODEX_COLOR_SCHEMES) {
  test(`capture ${scheme.label}`, async ({ context }) => {
    test.setTimeout(90_000);
    const directory = path.resolve(output!, scheme.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "theme.json"), JSON.stringify({ id: scheme.id, label: scheme.label, mode: scheme.mode }));
    await context.addInitScript(id => localStorage.setItem("kodex-color-scheme", id), scheme.id);
    const fixture = await nativeSettingsFixture(context);
    await context.route("**/v1/notifications/status", route => route.fulfill({ json: { configured: false, subscriptionsEnabled: false, vapidPublicKey: null } }));
    fixture.detail.thread.name = "Theme contrast audit";
    fixture.detail.timeline.rows = [message("user", "Review the contrast of selected controls, muted text, and code surfaces.", 1), message("assistant", "## Contrast review\n\nBody text should stay readable across every surface. **Emphasis**, *secondary detail*, and [a documentation link](https://example.com) belong to the same readable system.\n\n> Selection needs more than a faint tint.\n\nUse `text-primary` for content and semantic text tokens for status.\n\n```ts\nconst theme = { surface: 'panel', text: 'primary' };\n```\n\n| Primitive | Check |\n| --- | --- |\n| Input | Placeholder and focus |\n| Button | Label and filled background |\n\n- Normal list text\n- ~~Superseded note~~", 2)];
    fixture.detail.thread.status = "active";
    fixture.detail.liveState = "streaming";
    fixture.detail.timeline.activeTurnId = "audit-turn";
    fixture.detail.timeline.liveState = "streaming";
    fixture.detail.timeline.turns = [{ id: "audit-turn", status: "inProgress" }];
    fixture.queuedInputs.push(...["Review the implementation", "Add regression coverage for the queue", "A longer queued follow-up that should truncate cleanly while keeping all of its actions available"].map((text, index) => ({
      id: `audit-queue-${index}`, threadId: "settings-chat", clientUserMessageId: `audit-client-${index}`,
      input: [{ type: "text", text }], attachments: [], canSteer: true,
    })));
    const measurements: Record<string, unknown> = {};
    const page = await fixture.page("audit", "/__theme");
    async function capture(name: string, keepPointer = false) {
      if (!keepPointer) await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled" });
      measurements[name] = await page.evaluate(measureTheme as () => ReturnType<typeof measureTheme>);
      const detail = name.includes("preferences") || name === "10-notifications" || name === "06-modal" || name === "07-drawer"
        ? page.getByRole("dialog") : name === "02-menu" ? page.getByRole("menu") : null;
      if (detail) await detail.screenshot({ path: path.join(directory, `${name}-detail.png`), animations: "disabled" });
    }
    try {
      await page.setViewportSize({ width: 1440, height: 1800 });
      await expect(page.getByRole("main", { name: "Theme workbench" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-kodex-color-scheme", scheme.id);
      await capture("01-primitives");
      await page.getByRole("button", { name: "Subtle", exact: true }).hover();
      await capture("12-button-hover", true);
      await page.getByRole("button", { name: "Subtle", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "Light", exact: true })).toBeFocused();
      await capture("13-button-focus");
      await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await capture("02-menu");
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: "Plain select", exact: true }).click();
      await expect(page.getByRole("option", { name: "Project", exact: true })).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await capture("03-select");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open popover", exact: true }).click();
      await expect(page.getByText("Popover surface uses default chrome.")).toBeVisible();
      await capture("04-popover");
      await page.getByRole("button", { name: "Open popover", exact: true }).click();
      await expect(page.getByText("Popover surface uses default chrome.")).toBeHidden();
      await page.getByLabel("Plain text input", { exact: true }).focus();
      await capture("05-input-focus");
      await page.getByRole("button", { name: "Open modal", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Themed modal" })).toBeVisible();
      await capture("06-modal");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Open drawer", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Themed drawer" })).toBeVisible();
      await capture("07-drawer");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto("/threads/settings-chat");
      await expect(page.getByText("Body text should stay readable", { exact: false })).toBeVisible();
      await capture("08-chat");
      const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
      await sidebar.getByRole("button", { name: "Account settings", exact: true }).click();
      await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
      await expect(dialog).toBeVisible();
      await capture("09-preferences");
      await dialog.getByRole("button", { name: "Notifications", exact: true }).click();
      await expect(dialog.getByText("Your device’s notification settings also control alerts and app badges.")).toBeVisible();
      await capture("10-notifications");
      await dialog.getByRole("button", { name: "Interface", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("11-preferences-narrow");
      await writeFile(path.join(directory, "measurements.json"), JSON.stringify(measurements, null, 2));
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}
function message(role: "user" | "assistant", text: string, displayOrder: number): ThreadTimelineRow {
  const id = `audit-${role}`, itemType = role === "user" ? "userMessage" : "agentMessage";
  const item = role === "user" ? { id, type: itemType, content: [{ type: "text", text }] } : { id, type: itemType, phase: "final_answer", text };
  return { id, turnId: "audit-turn", kind: role === "user" ? "user_message" : "assistant_message", status: "completed", displayOrder,
    item: { id, itemId: id, turnId: "audit-turn", threadId: "settings-chat", itemType, status: "completed", displayOrder, timestampMs: Date.UTC(2026, 9, 6), codexMethod: "item/completed", payload: compactCanonicalPayload(item, { id, itemType }) } };
}

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  for (const scheme of KODEX_COLOR_SCHEMES) {
    test(`preferences ${scheme.label}`, async ({ context }) => {
      const directory = path.resolve(output!, scheme.id);
      await mkdir(directory, { recursive: true });
      await context.addInitScript(id => localStorage.setItem("kodex-color-scheme", id), scheme.id);
      const fixture = await nativeSettingsFixture(context);
      await context.route("**/v1/notifications/status", route => route.fulfill({ json: { configured: false, subscriptionsEnabled: false, vapidPublicKey: null } }));
      try {
        const page = await fixture.page("touch");
        await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Account settings", exact: true }).click();
        await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible();
        await page.screenshot({ path: path.join(directory, "14-preferences-touch.png"), animations: "disabled" });
        await writeFile(path.join(directory, "touch-measurements.json"), JSON.stringify(await page.evaluate(measureTheme as () => ReturnType<typeof measureTheme>), null, 2));
        expect(fixture.unexpected).toEqual([]);
        expect(fixture.errors).toEqual([]);
      } finally { await fixture.close(); }
    });
  }
});
