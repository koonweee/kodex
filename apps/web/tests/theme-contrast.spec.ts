import { expect, test, type Locator, type Page } from "@playwright/test";

import { KODEX_COLOR_SCHEMES } from "../src/themeRegistry";
import { nativeSettingsFixture } from "./native-settings.fixture";
import { measureTheme } from "./theme-contrast.measure";

// These are applicable, visible specimens, not a blanket audit of every DOM
// sample. Disabled controls and decorative separators are deliberately excluded.
async function sample(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  let result = await locator.evaluate(measureTheme);
  // Mantine portals can animate opacity through React timers, which are absent
  // from getAnimations(). Measure the settled visible paint, never a fade frame.
  await expect.poll(async () => {
    result = await locator.evaluate(measureTheme);
    return result.samples.length === 1 && !result.samples[0].unsupported;
  }, { message: "Specimen must have settled, measurable flat paint" }).toBe(true);
  expect(result.samples).toHaveLength(1);
  const measurement = result.samples[0];
  expect(measurement.unsupported, `Flat-color measurement unsupported: ${measurement.label}`).toBe(false);
  return measurement;
}

function readable(ratio: number | null, description: string, minimum = 4.5) {
  expect.soft(ratio, `${description} contrast must be measurable`).not.toBeNull();
  if (ratio !== null) expect.soft(ratio, `${description}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(minimum);
}

async function settle(page: Page) {
  // Wait for actual finite CSS transitions, without waiting for spinning loaders.
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
}

async function checkWorkbench(page: Page, label: string) {
  const buttonNames = ["Default button", "Subtle", "Light", "Filled", "Danger", "Default variant", "Outline", "Transparent", "Filled danger"];
  for (const name of buttonNames) {
    const button = page.getByRole("button", { name, exact: true });
    await page.mouse.move(0, 0);
    const resting = await sample(button.getByText(name, { exact: true }));
    readable(resting.ratio, `${label} ${name} label`);
    await button.hover();
    await settle(page);
    readable((await sample(button.getByText(name, { exact: true }))).ratio, `${label} ${name} hover label`);
  }
  for (const name of ["Plain action", "Filled action"]) {
    const button = page.getByRole("button", { name, exact: true });
    await page.mouse.move(0, 0);
    readable((await sample(button.locator("svg"))).ratio, `${label} ${name} icon`, 3);
    await button.hover();
    await settle(page);
    readable((await sample(button.locator("svg"))).ratio, `${label} ${name} hover icon`, 3);
  }
  for (const name of ["Plain loader", "Inherited loader"]) {
    const loader = await sample(page.getByLabel(name, { exact: true }));
    expect(loader.indicatorUnsupported, `${label} ${name} has a supported flat indicator`).toBe(false);
    readable(loader.indicatorRatio, `${label} ${name} visible rotating indicator`, 3);
  }

  await page.mouse.move(0, 0);
  for (const text of ["Mantine dimmed text on panel", "Kodex muted text on panel", "Default input chrome", "Field is required", "68% complete"]) {
    readable((await sample(page.getByText(text, { exact: true }))).ratio, `${label} ${text}`);
  }
  for (const name of ["Plain text input", "Plain textarea", "Plain autocomplete"]) {
    const input = page.getByRole("textbox", { name, exact: true });
    const measurement = await sample(input);
    readable(measurement.placeholderRatio, `${label} ${name} placeholder`);
    readable(measurement.borderRatio, `${label} ${name} outer boundary`, 3);
    readable(measurement.borderInnerRatio, `${label} ${name} inner boundary`, 3);
    await input.fill("Readable input text");
    readable((await sample(input)).ratio, `${label} ${name} entered text`);
    await input.fill("");
    await input.evaluate(element => (element as HTMLElement).blur());
  }
  readable((await sample(page.getByRole("button", { name: "Default variant", exact: true }))).borderRatio, `${label} default button boundary`, 3);
  readable((await sample(page.getByRole("checkbox", { name: "Unchecked checkbox", exact: true }))).borderRatio, `${label} unchecked checkbox boundary`, 3);
  readable((await sample(page.getByRole("radio", { name: "Ask", exact: true }))).borderRatio, `${label} unselected radio boundary`, 3);
  for (const [role, name, glyph] of [["checkbox", "Plain checkbox", "svg path"], ["radio", "Allow", "svg circle"]] as const) {
    const input = page.getByRole(role, { name, exact: true });
    await expect(input).toBeChecked();
    readable((await sample(input.locator("..").locator(glyph))).ratio, `${label} ${name} selected mark`, 3);
  }
  for (const name of ["Plain switch", "Unchecked switch"]) {
    const switchBody = page.getByRole("switch", { name, exact: true }).locator("..");
    const track = await sample(switchBody.locator(".mantine-Switch-track"));
    const thumb = await sample(switchBody.locator(".mantine-Switch-thumb"));
    readable(thumb.surfaceRatio, `${label} ${name} thumb against track`, 3);
    if (name === "Unchecked switch") {
      readable(track.borderRatio, `${label} ${name} outer boundary`, 3);
      readable(track.borderInnerRatio, `${label} ${name} inner boundary`, 3);
    }
  }

  const alertStyles = [];
  for (const [color, semanticBadge] of [["red", "Danger badge"], ["yellow", "warning badge"], ["green", "success badge"], ["blue", "info badge"]]) {
    const title = await sample(page.getByText(`${color} status`, { exact: true }));
    readable(title.ratio, `${label} ${color} status title`);
    readable((await sample(page.getByText(`Status with the ${color} color prop.`, { exact: true }))).ratio, `${label} ${color} status text`);
    alertStyles.push(JSON.stringify([title.foreground, title.background]));
    const semantic = await sample(page.getByText(semanticBadge, { exact: true }));
    expect.soft([title.foreground, title.background], `${label} ${color} alert matches its semantic status`).toEqual([semantic.foreground, semantic.background]);
  }
  expect.soft(new Set(alertStyles).size, `${label} semantic alert tones must visibly differ`).toBe(4);
  for (const text of ["Neutral badge", "Accent badge", "Danger badge", "success badge", "warning badge", "info badge", "Red prop badge"]) {
    readable((await sample(page.getByText(text, { exact: true }))).ratio, `${label} ${text}`);
  }
  const neutral = await sample(page.getByText("Neutral badge", { exact: true }));
  const redProp = await sample(page.getByText("Red prop badge", { exact: true }));
  // Solid and tinted badges may invert their pair; a status prop must still
  // visibly differ from a neutral badge of the same default variant.
  expect.soft([redProp.foreground, redProp.background]).not.toEqual([neutral.foreground, neutral.background]);

  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await settle(page);
  const deletion = page.getByRole("menuitem", { name: "Delete", exact: true });
  const deletionLabel = deletion.getByText("Delete", { exact: true });
  const deletionRest = await sample(deletionLabel);
  readable(deletionRest.ratio, `${label} danger menu label`);
  const archive = await sample(page.getByRole("menuitem", { name: "Archive", exact: true }).getByText("Archive", { exact: true }));
  expect.soft(deletionRest.foreground, `${label} destructive menu action differs from ordinary actions`).not.toBe(archive.foreground);
  await deletion.hover();
  await settle(page);
  readable((await sample(deletionLabel)).ratio, `${label} danger menu hover label`);
  await page.keyboard.press("Escape");

  for (const text of ["User bubble body text", "User bubble documentation link"]) {
    readable((await sample(page.getByText(text, { exact: true }))).ratio, `${label} ${text}`);
  }

  const nativeScroll = await sample(page.getByRole("region", { name: "Native scrollbar sample", exact: true }));
  readable(nativeScroll.scrollbarRatio, `${label} native scrollbar thumb`, 3);
  const customScroll = page.getByRole("region", { name: "Custom scrollbar sample", exact: true });
  const customBar = customScroll.locator("..").locator('.kodex-mantine-scroll-area-scrollbar[data-orientation="vertical"]');
  const thumb = customBar.locator(".kodex-mantine-scroll-area-thumb");
  await page.mouse.move(0, 0);
  readable((await sample(thumb)).surfaceRatio, `${label} custom scrollbar thumb`, 3);
  await customBar.hover();
  await settle(page);
  readable((await sample(thumb)).surfaceRatio, `${label} custom scrollbar hover thumb`, 3);

  // Tab produces actual keyboard focus, including :focus-visible styling.
  await page.getByRole("button", { name: "Subtle", exact: true }).focus();
  await page.keyboard.press("Tab");
  const light = page.getByRole("button", { name: "Light", exact: true });
  await expect(light).toBeFocused();
  const buttonFocus = await sample(light);
  readable(buttonFocus.focusRatio, `${label} keyboard button focus outer edge`, 3);
  readable(buttonFocus.focusInnerRatio, `${label} keyboard button focus inner edge`, 3);
  // Enter the input via keyboard too, rather than relying on programmatic focus.
  await page.getByRole("textbox", { name: "Plain textarea", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  const input = page.getByRole("textbox", { name: "Plain text input", exact: true });
  await expect(input).toBeFocused();
  const inputFocus = await sample(input);
  readable(inputFocus.borderRatio, `${label} focused input outer boundary`, 3);
  readable(inputFocus.borderInnerRatio, `${label} focused input inner boundary`, 3);
  await page.getByRole("checkbox", { name: "Plain checkbox", exact: true }).focus();
  await page.keyboard.press("Tab");
  const switchInput = page.getByRole("switch", { name: "Plain switch", exact: true });
  await expect(switchInput).toBeFocused();
  const switchFocus = await sample(switchInput.locator("..").locator(".mantine-Switch-track"));
  readable(switchFocus.focusRatio, `${label} keyboard switch focus outer edge`, 3);
  const segment = page.getByRole("radio", { name: "Preview", exact: true });
  await segment.focus();
  await expect(segment).toBeFocused();
  const segmentFocus = await sample(segment.locator("..").locator("label"));
  readable(segmentFocus.focusRatio, `${label} keyboard segment focus outer edge`, 3);
  readable(segmentFocus.focusInnerRatio, `${label} keyboard segment focus inner edge`, 3);

}

async function renderedPairs(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await settle(page);
  const specimens = [
    page.getByRole("button", { name: "Filled", exact: true }).getByText("Filled", { exact: true }),
    page.getByRole("button", { name: "Filled action", exact: true }).locator("svg"),
    page.getByText("Mantine dimmed text on panel", { exact: true }),
    page.getByRole("textbox", { name: "Plain text input", exact: true }),
    ...["red", "yellow", "green", "blue"].map(color => page.getByText(`${color} status`, { exact: true })),
    page.getByRole("region", { name: "Native scrollbar sample", exact: true }),
    page.locator('.kodex-mantine-scroll-area-thumb').first(),
  ];
  const pairs = [];
  for (const locator of specimens) {
    const measured = await sample(locator);
    pairs.push({ foreground: measured.foreground, background: measured.background, placeholderRatio: measured.placeholderRatio, borderRatio: measured.borderRatio, scrollbarColor: measured.scrollbarColor });
  }
  return pairs;
}

for (const scheme of KODEX_COLOR_SCHEMES) {
  test(`rendered semantic contrast: ${scheme.label}`, async ({ context }) => {
    test.setTimeout(60_000);
    await context.addInitScript(id => localStorage.setItem("kodex-color-scheme", id), scheme.id);
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("contrast", "/__theme");
      await page.setViewportSize({ width: 1440, height: 1450 });
      await expect(page.getByRole("main", { name: "Theme workbench" })).toBeVisible();
      await checkWorkbench(page, scheme.label);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}

test("rendered controls recompute across dark and light theme switches", async ({ context }) => {
  test.setTimeout(90_000);
  await context.addInitScript(() => {
    if (localStorage.getItem("kodex-color-scheme") === null) localStorage.setItem("kodex-color-scheme", "dracula");
  });
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("live-contrast", "/__theme");
    await page.setViewportSize({ width: 1440, height: 1450 });
    const filled = page.getByRole("button", { name: "Filled", exact: true }).getByText("Filled", { exact: true });
    const original = await sample(filled);
    const reference = await fixture.page("fresh-theme", "/__theme");
    await reference.setViewportSize({ width: 1440, height: 1450 });
    await expect(reference.getByRole("radio", { name: "Dracula", exact: true })).toBeChecked();
    await settle(reference);
    for (const id of ["paper-light", "monokai", "oled-black", "dracula"]) {
      const scheme = KODEX_COLOR_SCHEMES.find(scheme => scheme.id === id)!;
      await page.getByRole("radio", { name: scheme.label, exact: true }).click();
      await expect(page.getByRole("radio", { name: scheme.label, exact: true })).toBeChecked();
      await settle(page);
      await checkWorkbench(page, `${scheme.label} after live switch`);
      // A freshly mounted page is an independent rendered baseline, so a stale
      // Mantine resolver cannot pass merely because its old colors remain legible.
      await reference.reload();
      await expect(reference.getByRole("radio", { name: scheme.label, exact: true })).toBeChecked();
      await settle(reference);
      expect(await renderedPairs(page), `${scheme.label} live controls match a fresh render`).toEqual(await renderedPairs(reference));
    }
    const restored = await sample(filled);
    expect([restored.foreground, restored.background], "Returning to the initial theme restores its rendered pair").toEqual([original.foreground, original.background]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
