import { afterEach, describe, expect, it, vi } from "vitest";
import { openTerminalLink } from "./terminalLinks";

afterEach(() => vi.restoreAllMocks());
describe("terminal links", () => {
  it("opens HTTP links in an isolated new tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openTerminalLink(new MouseEvent("click"), "https://example.com/device");
    expect(open).toHaveBeenCalledWith("https://example.com/device", "_blank", "noopener,noreferrer");
  });
  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,test", "not a url"])("does not open %s", (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openTerminalLink(new MouseEvent("click"), url);
    expect(open).not.toHaveBeenCalled();
  });
});
