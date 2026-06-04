import { describe, expect, it } from "vitest";

import { buildGeneratedUiSrcDoc, buildGeneratedUiThemeCss, GENERATED_UI_DOCUMENT_CSP } from "./themeDocument";

describe("generated UI theme document", () => {
  it("builds a compact Kodex theme token stylesheet for the selected color scheme", () => {
    const css = buildGeneratedUiThemeCss("paper-light");

    expect(css).toContain("color-scheme: light;");
    expect(css).toContain("--kodex-bg-app: #ece6db;");
    expect(css).toContain("--kodex-text-primary: #2f271f;");
    expect(css).toContain("--kodex-bg-panel: var(--kodex-bg-thread-surface);");
    expect(css).toContain("--kodex-radius-md: 8px;");
  });

  it("injects CSP and theme tokens into an existing document head before generated content", () => {
    const srcDoc = buildGeneratedUiSrcDoc(
      "<!doctype html><html><head><title>Picker</title></head><body><button>Pick</button></body></html>",
      "oled-black",
    );

    expect(srcDoc).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    expect(srcDoc.indexOf("kodex-generated-ui-theme")).toBeLessThan(srcDoc.indexOf("<title>Picker</title>"));
    expect(srcDoc).toContain(GENERATED_UI_DOCUMENT_CSP);
    expect(srcDoc).toContain("--kodex-bg-app: #050505;");
    expect(srcDoc).toContain("<button>Pick</button>");
  });

  it("wraps an HTML fragment in a themed self-contained document", () => {
    const srcDoc = buildGeneratedUiSrcDoc("<main>Generated form</main>", "dracula");

    expect(srcDoc).toMatch(/^<!doctype html>/);
    expect(srcDoc).toContain("<body>\n<main>Generated form</main>\n</body>");
    expect(srcDoc).toContain("color-scheme: dark;");
    expect(srcDoc).toContain("--kodex-accent: #bd93f9;");
  });
});
