import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptMarkdownEditor } from "./PromptMarkdownEditor";

function Editor() {
  const [value, setValue] = useState("A draft prompt");
  return <MantineProvider env="test"><PromptMarkdownEditor value={value} onChange={setValue} /></MantineProvider>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("automation prompt available-space layout", () => {
  it("uses tabs in a narrow editor inside a wide workspace and keeps input continuity on resize", () => {
    let width = 400;
    const observers: Array<{ callback: ResizeObserverCallback; target: Element }> = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, width, height: 800, toJSON: () => ({}),
    }));
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { observers.push({ callback: this.callback, target }); }
      disconnect() {}
    });
    render(<Editor />);
    expect(screen.getByRole("tab", { name: "Write" })).toBeVisible();
    const textarea = screen.getByRole("textbox", { name: "Automation prompt" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Keep this draft while resizing" } });
    act(() => { textarea.focus(); textarea.setSelectionRange(5, 9); });

    width = 1000;
    act(() => { for (const { callback, target } of observers) callback([
      { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry,
    ], {} as ResizeObserver); });
    expect(screen.queryByRole("tab", { name: "Write" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Automation prompt" })).toBe(textarea);
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue("Keep this draft while resizing");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 9]);

    width = 400;
    act(() => { for (const { callback, target } of observers) callback([
      { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry,
    ], {} as ResizeObserver); });
    expect(screen.getByRole("tab", { name: "Write" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Automation prompt" })).toBe(textarea);
    expect(textarea).toHaveFocus();
  });
});
