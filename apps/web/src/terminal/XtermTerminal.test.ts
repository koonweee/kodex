import { describe, expect, it } from "vitest";

import { terminalThemeColors } from "./XtermTerminal";

describe("terminalThemeColors", () => {
  it("reads terminal colors from Kodex CSS variables", () => {
    const element = document.createElement("div");
    element.style.setProperty("--kodex-terminal-bg", "rgb(21, 21, 21)");
    element.style.setProperty("--kodex-text-primary", "rgb(47, 39, 31)");
    element.style.setProperty("--kodex-bg-selected-strong", "rgb(207, 229, 218)");
    document.body.append(element);

    expect(terminalThemeColors(element)).toEqual({
      background: "rgb(21, 21, 21)",
      cursor: "rgb(47, 39, 31)",
      foreground: "rgb(47, 39, 31)",
      selectionBackground: "rgb(207, 229, 218)",
    });

    element.remove();
  });

  it("falls back when CSS variables are unavailable", () => {
    expect(terminalThemeColors(document.createElement("div"))).toEqual({
      background: "#11151f",
      cursor: "#f8fafc",
      foreground: "#e5e7eb",
      selectionBackground: "#40517a",
    });
  });
});
