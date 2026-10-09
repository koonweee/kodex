import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

function content(text: string, deltaStart?: number, running = true) {
  return <MantineProvider><MarkdownContent text={text} streaming={running ? { identity: "thread:answer", deltaStart } : undefined} /></MantineProvider>;
}
function animations() {
  const cancel = vi.fn();
  const animatedText: string[] = [];
  const animate = vi.fn(function(this: HTMLElement) {
    animatedText.push(this.textContent ?? "");
    return { currentTime: 0, cancel };
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  return { animate, animatedText, cancel };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).animate;
});

describe("live Markdown presentation", () => {
  it("fades only a live append without reparsing on a quiet-period timer", () => {
    vi.useFakeTimers();
    const animation = animations();
    const { rerender, container } = render(content("Earlier text."));
    expect(animation.animate).not.toHaveBeenCalled();
    rerender(content("Earlier text. New words.", 13));
    expect(container).toHaveTextContent("Earlier text. New words.");
    expect(animation.animatedText.join("")).toBe(" New words.");
    const rendered = container.innerHTML;
    const count = animation.animate.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(container.innerHTML).toBe(rendered);
    expect(animation.animate).toHaveBeenCalledTimes(count);
    rerender(content("Earlier text. New words.", undefined, false));
    expect(container).toHaveTextContent("Earlier text. New words.");
    expect(container.querySelectorAll("[data-stream-born]")).toHaveLength(0);
  });

  it("snaps append-like snapshot replacement, completion and correction without replay", () => {
    const animation = animations();
    const { rerender, container } = render(content("Seed"));
    rerender(content("Seed live", 4));
    expect(animation.animate).toHaveBeenCalled();
    animation.animate.mockClear();
    rerender(content("Seed live recovered"));
    expect(animation.animate).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-stream-born]")).toHaveLength(0);
    rerender(content("Corrected **answer**", undefined, false));
    expect(screen.getByText("answer").tagName).toBe("STRONG");
    expect(container).not.toHaveTextContent("Seed");
    expect(animation.cancel).toHaveBeenCalled();
  });

  it("keeps Markdown semantics and complete Unicode when deltas close syntax or graphemes", () => {
    animations();
    const { rerender, container } = render(content("Read **bold"));
    rerender(content("Read **bold** and [link](https://example.com).", 11));
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.com");
    rerender(content("Emoji \ud83d"));
    rerender(content("Emoji 👩‍💻", 7));
    expect(container).toHaveTextContent("Emoji 👩‍💻");
    const text = screen.getByText("Emoji 👩‍💻");
    expect(text.childNodes).toHaveLength(1);
  });

  it("cancels hidden-tab work and shows recovery text without replaying old fades", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const animation = animations();
    const { rerender, container, unmount } = render(content("Seed"));
    rerender(content("Seed visible", 4));
    expect(animation.animate).toHaveBeenCalled();
    act(() => {
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(animation.cancel).toHaveBeenCalled();
    animation.animate.mockClear();
    rerender(content("Seed visible background update", 12));
    expect(container).toHaveTextContent("Seed visible background update");
    act(() => {
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(animation.animate).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-stream-born]")).toHaveLength(0);
    rerender(content("Seed visible background update foreground", 30));
    expect(animation.animate).toHaveBeenCalled();
    animation.cancel.mockClear();
    unmount();
    expect(animation.cancel).toHaveBeenCalled();
  });

  it("preserves selected streamed nodes through hidden-tab updates and recovery", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const animation = animations();
    const { rerender, container } = render(content("Seed"));
    rerender(content("Seed selected suffix", 4));
    const span = container.querySelector("[data-stream-born]")!;
    const selectedText = span.textContent;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(span.firstChild!);
    act(() => {
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(selection.toString()).toBe(selectedText);
    animation.animate.mockClear();
    act(() => {
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(selection.toString()).toBe(selectedText);
    rerender(content("Seed selected suffix background", 20));
    expect(container).toHaveTextContent("Seed selected suffix background");
    expect(selection.toString()).toBe(selectedText);
    act(() => {
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(selection.toString()).toBe(selectedText);
    expect(animation.animate).not.toHaveBeenCalled();
    act(() => {
      selection.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(container).toHaveTextContent("Seed selected suffix background");
    expect(container.querySelectorAll("[data-stream-born]")).toHaveLength(0);
  });

  it("does no animation work with reduced motion", () => {
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...matchMedia(query), matches: query === "(prefers-reduced-motion: reduce)" }));
    const animation = animations();
    const { rerender, container } = render(content("Seed"));
    rerender(content("Seed new text", 4));
    expect(container).toHaveTextContent("Seed new text");
    expect(animation.animate).not.toHaveBeenCalled();
  });
});
