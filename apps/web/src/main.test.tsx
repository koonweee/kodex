import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKodexColorSchemeBootstrapScript } from "./themeRegistry";

const renderMock = vi.fn();
const createRootMock = vi.fn(() => ({ render: renderMock }));

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

vi.mock("./App", () => ({
  App: () => null,
}));

describe("main entrypoint", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-kodex-color-scheme");
    document.documentElement.removeAttribute("data-mantine-color-scheme");
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = "";
    renderMock.mockReset();
    createRootMock.mockClear();
    vi.resetModules();
  });

  it("applies the persisted color scheme before the React app renders", async () => {
    window.localStorage.setItem("kodex-color-scheme", "paper-light");
    document.body.innerHTML = '<div id="root"></div>';

    renderMock.mockImplementation(() => {
      expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "paper-light");
      expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
    });

    await import("./main");

    expect(createRootMock).toHaveBeenCalledWith(document.getElementById("root"));
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("bootstraps the persisted color scheme before the app module runs", () => {
    window.localStorage.setItem("kodex-color-scheme", "monokai");
    document.documentElement.removeAttribute("data-kodex-color-scheme");
    document.documentElement.removeAttribute("data-mantine-color-scheme");

    new Function(buildKodexColorSchemeBootstrapScript())();

    expect(document.documentElement).toHaveAttribute("data-kodex-color-scheme", "monokai");
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "dark");
  });
});
