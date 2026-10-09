import { expect, test, type Page } from "@playwright/test";

async function mountSummary(page: Page, initialCount: number) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/activity-command-count-test", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
      <div id="root" style="padding:24px"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { default: { flushSync } } = await import('/node_modules/.vite/deps/react-dom.js');
        const source = await (await fetch('/src/timeline/ActivityGroupSummary.tsx')).text();
        const mantineUrl = source.match(/from "([^"]*@mantine_core[^"]*)"/)[1];
        const { MantineProvider } = await import(mantineUrl);
        await import('/node_modules/@mantine/core/styles.css');
        await import('/src/styles/base.css');
        await import('/src/styles/ui.css');
        await import('/src/styles/mantine-theme.css');
        await import('/src/styles/timeline-activity.css');
        const { applyKodexColorScheme, getKodexColorScheme, createKodexMantineTheme } = await import('/src/theme.ts');
        const scheme = getKodexColorScheme('oled-black');
        applyKodexColorScheme(document.documentElement, scheme);
        for (const [name, value] of Object.entries(scheme.rootVariables)) document.documentElement.style.setProperty(name, value);
        const theme = createKodexMantineTheme(scheme);
        const { ActivityGroupSummary } = await import('/src/timeline/ActivityGroupSummary.tsx');
        const { TimelineWorkRowRenderer } = await import('/src/timeline/workRenderer.tsx');
        const root = createRoot(document.getElementById('root'));
        window.setCommandCount = count => flushSync(() => root.render(
          React.createElement(MantineProvider, { theme, forceColorScheme: scheme.mode },
            React.createElement('details', { className: 'kodex-activity-group' },
              React.createElement('summary', null,
                React.createElement(ActivityGroupSummary, { items: Array.from({ length: count }, (_, index) => ({
                  id: 'command-' + index, kind: 'command_execution', command: 'pwd', status: 'completed',
                  text: '', turnId: 'turn', displayOrder: index, payload: {}, debugEvents: [],
                })) }))
            )
          )
        ));
        window.setWorkSeconds = seconds => flushSync(() => root.render(
          React.createElement(MantineProvider, { theme, forceColorScheme: scheme.mode },
            React.createElement(TimelineWorkRowRenderer, { row: {
              kind: 'work', id: 'work', turnId: 'turn', state: 'completed',
              startedAtMs: 0, completedAtMs: seconds * 1000, collapsedRows: [],
            }}))));
        window.setCommandCount(${initialCount});
      </script>
    </body></html>`,
  }));
  await page.goto("/activity-command-count-test");
  await expect(page.locator("summary")).toHaveAccessibleName(`Ran ${initialCount} commands`);
  return errors;
}

async function snapshot(page: Page, count?: number) {
  return page.evaluate((nextCount) => {
    if (nextCount !== undefined) {
      (window as unknown as { setCommandCount(count: number): void }).setCommandCount(nextCount);
    }
    const summary = document.querySelector("summary")!;
    const visible = summary.querySelector('[aria-hidden="true"]')!;
    const walker = document.createTreeWalker(visible, NodeFilter.SHOW_TEXT);
    let suffixRect: { x: number; width: number } | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf("commands") ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + "commands".length);
      const rect = range.getBoundingClientRect();
      suffixRect = { x: rect.x, width: rect.width };
    }
    const animations = summary.getAnimations({ subtree: true }).map((animation) => {
      const effect = animation.effect as KeyframeEffect;
      const target = effect.target as HTMLElement;
      return { text: target.textContent, duration: effect.getTiming().duration,
        movingProperties: [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)
          .filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key))))] };
    });
    const old = summary.querySelector<HTMLElement>(".kodex-animated-number-old");
    const current = summary.querySelector<HTMLElement>(".kodex-animated-number-new");
    return { animations, suffixRect, oldText: old?.textContent ?? null, currentText: current?.textContent ?? null,
      oldVisible: !!old && getComputedStyle(old).display !== "none" && getComputedStyle(old).visibility !== "hidden" };
  }, count);
}

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("changing counts roll, with stable text and the latest accessible value", async ({ page }, testInfo) => {
      const errors = await mountSummary(page, 9);
      const initial = await snapshot(page);
      expect(initial.animations).toEqual([]);
      await page.locator("summary").screenshot({ path: testInfo.outputPath("settled.png") });
      const increased = await snapshot(page, 10);
      expect(increased.animations).toHaveLength(2);
      await page.evaluate(() => {
        for (const animation of document.querySelector("summary")!.getAnimations({ subtree: true })) {
          animation.pause(); animation.currentTime = 75;
        }
      });
      await page.locator("summary").screenshot({ path: testInfo.outputPath("rolling.png"), animations: "allow" });
      expect(increased.animations.map((animation) => animation.text).sort()).toEqual(["10", "9"]);
      for (const animation of increased.animations) {
        expect(animation.duration).toBeLessThanOrEqual(200);
        expect(animation.movingProperties.sort()).toEqual(["opacity", "transform"]);
      }
      // Digit growth changes natural width immediately; the suffix never rolls.
      expect((await snapshot(page)).suffixRect).toEqual(increased.suffixRect);
      await expect(page.locator("summary")).toHaveAccessibleName("Ran 10 commands");
      const rapid = await page.evaluate(() => {
        const update = (window as unknown as { setCommandCount(count: number): void }).setCommandCount;
        update(11); update(14); update(17);
        return [...document.querySelectorAll(".kodex-animated-number-new")].map((node) => node.textContent);
      });
      expect(rapid).toEqual(["17"]);
      await expect(page.locator("summary")).toHaveAccessibleName("Ran 17 commands");
      await expect.poll(async () => (await snapshot(page)).animations.length).toBe(0);
      expect((await snapshot(page)).oldText).toBeNull();
      const decreased = await snapshot(page, 9);
      expect(decreased.animations).toHaveLength(2);
      await expect(page.locator("summary")).toHaveAccessibleName("Ran 9 commands");
      await snapshot(page, 99);
      await expect.poll(async () => (await snapshot(page)).animations.length).toBe(0);
      const twoDigits = await snapshot(page);
      const threeDigits = await snapshot(page, 100);
      expect(threeDigits.suffixRect!.x).toBeGreaterThanOrEqual(twoDigits.suffixRect!.x);
      await expect.poll(async () => (await snapshot(page)).animations.length).toBe(0);
      expect((await snapshot(page)).suffixRect).toEqual(threeDigits.suffixRect);
      await expect(page.locator("summary")).toHaveAccessibleName("Ran 100 commands");
      expect(errors).toEqual([]);
    });

    test("reduced motion works on mount and when enabled during a roll", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const errors = await mountSummary(page, 9);
      const reduced = await snapshot(page, 10);
      expect(reduced.animations).toEqual([]);
      expect(reduced.oldVisible).toBe(false);
      await expect(page.locator("summary")).toHaveAccessibleName("Ran 10 commands");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect((await snapshot(page)).animations).toEqual([]);
      const rolling = await snapshot(page, 11);
      expect(rolling.animations).toHaveLength(2);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const stopped = await snapshot(page);
      expect(stopped.animations).toEqual([]);
      expect(stopped.oldVisible).toBe(false);
      expect(stopped.oldText).toBeNull();
      await expect(page.locator("summary")).toHaveAccessibleName("Ran 11 commands");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const resumed = await snapshot(page);
      expect(resumed.animations).toEqual([]);
      expect(resumed.oldText).toBeNull();
      expect(errors).toEqual([]);
    });
  });
}

test("work durations roll seconds across minute and hour boundaries", async ({ page }, info) => {
  const errors = await mountSummary(page, 2);
  const work = page.locator(".kodex-work-row p");
  const setSeconds = async (seconds: number) => page.evaluate(seconds => {
    (window as unknown as { setWorkSeconds(seconds: number): void }).setWorkSeconds(seconds);
    const work = document.querySelector(".kodex-work-row")!;
    return work.getAnimations({ subtree: true }).map(animation => (animation.effect as KeyframeEffect).target?.textContent);
  }, seconds);
  expect(await setSeconds(59)).toEqual([]);
  expect((await setSeconds(60)).sort()).toEqual(["00", "59"]);
  await expect(work).toContainText("Worked for 1m 00s");
  await work.screenshot({ path: info.outputPath("worked-duration-boundary.png"), animations: "allow" });
  await expect.poll(() => work.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  expect((await setSeconds(61)).sort()).toEqual(["00", "01"]);
  await expect.poll(() => work.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await setSeconds(3599);
  await expect.poll(() => work.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  expect((await setSeconds(3600)).sort()).toEqual(["00", "00", "59", "59"]);
  await expect(work).toContainText("Worked for 1h 00m 00s");
  expect(errors).toEqual([]);
});
