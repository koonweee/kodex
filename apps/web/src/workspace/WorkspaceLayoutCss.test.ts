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
    expect(paneHostRule).toContain("height: 100%;");
    expect(paneHostRule).toContain("overflow: hidden;");
    expect(paneHostRule).toContain("min-height: 0;");
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
