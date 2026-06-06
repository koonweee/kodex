import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workspaceCss = readFileSync("src/styles/workspace.css", "utf8");

describe("workspace pane layout CSS", () => {
  it("lays out thread pane composers as a normal bottom row", () => {
    const paneRule = cssRule(".kodex-thread-pane");
    const composerRule = cssRule(".kodex-thread-pane-existing > .kodex-composer-shell");
    const contentRule = cssRule(".kodex-thread-pane-existing > .kodex-thread-content");
    const scrollRule = cssRule(".kodex-thread-pane-scroll");
    const statusRule = cssRule(".kodex-thread-pane-status");

    expect(paneRule).toContain("grid-template-rows: auto auto minmax(0, 1fr) auto;");
    expect(paneRule).not.toContain("position: relative;");
    expect(composerRule).not.toContain("position: absolute;");
    expect(composerRule).toContain("align-self: end;");
    expect(composerRule).toContain("grid-row: 4;");
    expect(composerRule).toContain("justify-self: center;");
    expect(contentRule).toContain("grid-row: 3;");
    expect(scrollRule).toContain("padding: 8px 0 20px;");
    expect(statusRule).toContain("display: grid;");
    expect(workspaceCss).not.toContain("--kodex-thread-pane-composer-reserve");
  });

  it("lets Dockview panel content become a fixed-height workspace pane", () => {
    const dockContentRule = cssRule(".kodex-workspace-dock .dv-content-container");
    const dockReactPartRule = cssRule(".kodex-workspace-dock .dv-react-part");
    const dockViewRule = cssRule(".kodex-workspace-dock .dv-view");
    const paneHostRule = cssRule(".kodex-workspace-pane-host");

    expect(dockContentRule).toContain("height: 100%;");
    expect(dockContentRule).toContain("overflow: hidden;");
    expect(dockReactPartRule).toContain("height: 100%;");
    expect(dockReactPartRule).toContain("overflow: hidden;");
    expect(dockViewRule).toContain("overflow: hidden;");
    expect(paneHostRule).toContain("--kodex-workspace-pane-padding: 8px;");
    expect(paneHostRule).toContain("box-sizing: border-box;");
    expect(paneHostRule).toContain("height: 100%;");
    expect(paneHostRule).toContain("overflow: hidden;");
    expect(paneHostRule).toContain("padding: var(--kodex-workspace-pane-padding);");
    expect(paneHostRule).toContain("min-height: 0;");
  });

  it("maps Dockview chrome variables onto Kodex theme tokens", () => {
    const dockRule = cssRuleContaining("--dv-group-view-background-color");

    expect(dockRule).toContain(".kodex-workspace-dock .dockview-theme-abyss");
    expect(dockRule).toContain("--dv-group-view-background-color: var(--kodex-bg-panel);");
    expect(dockRule).toContain("--dv-tabs-and-actions-container-background-color: var(--kodex-bg-shell);");
    expect(dockRule).toContain("--dv-activegroup-visiblepanel-tab-color: var(--kodex-text-primary);");
    expect(dockRule).toContain("--dv-activegroup-hiddenpanel-tab-color: var(--kodex-text-secondary);");
    expect(dockRule).toContain("--dv-inactivegroup-hiddenpanel-tab-color: var(--kodex-text-muted);");
    expect(dockRule).toContain("--dv-tab-divider-color: var(--kodex-border-subtle);");
    expect(dockRule).toContain("--dv-paneview-active-outline-color: var(--kodex-border-accent);");
    expect(dockRule).toContain("--dv-drag-over-border-color: var(--kodex-border-accent-soft);");
    expect(dockRule).toContain("--dv-icon-hover-background-color: var(--kodex-bg-button-hover);");
    expect(dockRule).toContain("--dv-floating-box-shadow: var(--kodex-shadow-floating);");
  });

  it("does not reference undefined legacy surface aliases", () => {
    expect(workspaceCss).not.toMatch(/--kodex-surface-[01]\b/);
    expect(workspaceCss).not.toContain("--kodex-surface-hover");
    expect(workspaceCss).not.toContain("--kodex-border-color");
  });

  it("keeps draft pane composers centered instead of bottom-pinned", () => {
    expect(cssRule(".kodex-thread-pane-empty")).toContain("grid-template-rows: auto minmax(0, 1fr);");
    expect(cssRule(".kodex-thread-pane-empty-body")).toContain("align-content: center;");
    expect(cssRule(".kodex-thread-pane-empty-body > .kodex-composer-shell")).toContain(
      "width: min(920px, calc(100% - 24px));",
    );
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workspaceCss.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "s"));
  expect(match, `Expected CSS rule for ${selector}`).not.toBeNull();
  return match?.[0] ?? "";
}

function cssRuleContaining(declaration: string): string {
  const escapedDeclaration = declaration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workspaceCss.match(new RegExp(`[^{}]*\\{[^}]*${escapedDeclaration}[^}]*\\}`, "s"));
  expect(match, `Expected CSS rule containing ${declaration}`).not.toBeNull();
  return match?.[0] ?? "";
}
