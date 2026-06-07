import { describe, expect, it } from "vitest";

import { buildAppSurfaceResourceHtml, buildAppSurfaceThemeCss } from "./document";

describe("app surface document theming", () => {
  it("injects a themed default page background and foreground", () => {
    const css = buildAppSurfaceThemeCss("oled-black");

    expect(css).toContain("--kodex-app-surface-bg: var(--kodex-bg-panel);");
    expect(css).toContain("min-height: 100vh;");
    expect(css).toContain("background: var(--kodex-app-surface-bg) !important;");
    expect(css).toContain("color: var(--kodex-text-primary);");
  });

  it("wraps body-only app surface HTML with the theme injection", () => {
    const html = buildAppSurfaceResourceHtml("<main>Surface</main>", "oled-black");

    expect(html).toContain('<style id="kodex-app-surface-theme">');
    expect(html).toContain("background: var(--kodex-app-surface-bg) !important;");
    expect(html).toContain("<body>");
    expect(html).toContain("<main>Surface</main>");
  });

  it("injects the theme after existing head styles so the iframe canvas stays themed", () => {
    const html = buildAppSurfaceResourceHtml(
      "<!doctype html><html><head><style>body { background: white; }</style></head><body>Surface</body></html>",
      "oled-black",
    );

    expect(html.indexOf("body { background: white; }")).toBeLessThan(html.indexOf('id="kodex-app-surface-theme"'));
  });
});
