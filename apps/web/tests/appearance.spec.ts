import { expect, test, type Page } from "@playwright/test";
import { measureTheme } from "./theme-contrast.measure";
import { nativeSettingsFixture } from "./native-settings.fixture";

async function openAppearance(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await sidebar.getByRole("button", { name: "Account settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
  return page.getByRole("dialog", { name: "Preferences", exact: true });
}

test("Auto follows the system with saved light/dark choices and converges across tabs", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const first = await fixture.page("appearance-first");
    const second = await fixture.page("appearance-second");
    await first.emulateMedia({ colorScheme: "dark" });
    await second.emulateMedia({ colorScheme: "dark" });
    const dialog = await openAppearance(first);
    const mode = dialog.getByRole("radiogroup", { name: "Appearance mode", exact: true });
    await expect(mode.getByRole("radio", { name: "Auto", exact: true })).toBeChecked();
    await dialog.getByRole("radiogroup", { name: "Browse themes", exact: true }).getByText("Dark", { exact: true }).click();
    await dialog.getByRole("radio", { name: "Dracula", exact: true }).click();
    for (const page of [first, second]) await expect(page.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
    await dialog.getByRole("radiogroup", { name: "Browse themes", exact: true }).getByText("Light", { exact: true }).click();
    await dialog.getByRole("radio", { name: "Catppuccin Latte", exact: true }).click();
    await expect(first.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
    await first.emulateMedia({ colorScheme: "light" });
    await expect(first.locator("html")).toHaveAttribute("data-kodex-color-scheme", "catppuccin-latte");
    await expect(second.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
    await mode.getByText("Dark", { exact: true }).click();
    for (const page of [first, second]) await expect(page.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
    await first.reload();
    await expect(first.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
    const reopened = await openAppearance(first);
    await reopened.getByRole("radiogroup", { name: "Appearance mode", exact: true }).getByText("Auto", { exact: true }).click();
    await expect(first.locator("html")).toHaveAttribute("data-kodex-color-scheme", "catppuccin-latte");
    await first.emulateMedia({ colorScheme: "dark" });
    await expect(first.locator("html")).toHaveAttribute("data-kodex-color-scheme", "dracula");
    await first.keyboard.press("Escape");
    const composer = first.getByRole("textbox", { name: "Message composer", exact: true }).last();
    await composer.focus();
    await expect(composer).toBeFocused();
    const focus = await composer.evaluate(measureTheme);
    expect(focus.samples[0].focusRatio).toBeGreaterThanOrEqual(3);
    await first.screenshot({ path: test.info().outputPath("composer-focus.png") });
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await fixture.close(); }
});
