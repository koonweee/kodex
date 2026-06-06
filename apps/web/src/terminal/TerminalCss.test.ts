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

  it("keeps terminal edge spacing owned by terminal content", () => {
    expect(terminalCss).toContain("--kodex-terminal-edge-space: 10px;");
    expect(terminalCss).toContain(
      "padding: 8px var(--kodex-terminal-edge-space) 8px calc(var(--kodex-terminal-edge-space) + 2px);",
    );
    expect(terminalCss).toContain("padding: 6px var(--kodex-terminal-edge-space);");
    expect(terminalCss).toContain("padding: 8px var(--kodex-terminal-edge-space);");
    expect(terminalCss).toMatch(/\.kodex-terminal-viewport\s*\{[^}]*background:\s*var\(--kodex-terminal-bg\);/s);
  });

  it("does not reference undefined legacy surface aliases", () => {
    expect(terminalCss).not.toMatch(/--kodex-surface-[01]\b/);
    expect(terminalCss).not.toContain("--kodex-border-color");
  });
});
