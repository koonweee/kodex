import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const terminalCss = readFileSync("src/styles/terminal.css", "utf8");

describe("terminal CSS theme tokens", () => {
  it("uses defined Kodex theme tokens for shell surfaces", () => {
    expect(terminalCss).toContain("var(--kodex-border-subtle)");
    expect(terminalCss).toContain("var(--kodex-bg-app)");
    expect(terminalCss).toContain("var(--kodex-bg-raised)");
    expect(terminalCss).toContain("var(--kodex-shadow-strong)");
    expect(terminalCss).toContain("--kodex-terminal-bg: color-mix(in srgb, var(--kodex-bg-app) 96%, black);");
    expect(terminalCss).toContain("background: var(--kodex-terminal-bg);");
  });

  it("does not reference undefined legacy surface aliases", () => {
    expect(terminalCss).not.toMatch(/--kodex-surface-[01]\b/);
    expect(terminalCss).not.toContain("--kodex-border-color");
  });
});
