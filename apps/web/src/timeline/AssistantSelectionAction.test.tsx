import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantSelectionAction } from "./AssistantSelectionAction";

const rect = (left = 100, top = 200, width = 180, height = 20) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
});

function mount(props: { disabled?: boolean; draftKey?: string } = {}) {
  const composerShellRef = createRef<HTMLDivElement>();
  const onAdd = vi.fn();
  const view = (options = props) => (
    <MantineProvider>
      <div className="kodex-thread-pane">
        <div className="kodex-thread-pane-scroll">
          <div className="kodex-assistant-markdown" data-testid="assistant"><p>  Selected <strong>literal</strong> text.  </p></div>
          <div className="kodex-assistant-markdown" data-testid="second">Second reply</div>
          <div data-testid="user">User message</div>
          <aside><div className="kodex-assistant-markdown" data-testid="subagent">Subagent reply</div></aside>
        </div>
        <div ref={composerShellRef}><textarea aria-label="Message" /></div>
        <AssistantSelectionAction composerShellRef={composerShellRef} disabled={options.disabled ?? false} draftKey={options.draftKey} onAdd={onAdd} />
      </div>
      <div className="kodex-thread-pane"><div className="kodex-thread-pane-scroll"><div className="kodex-assistant-markdown" data-testid="other">Other pane</div></div></div>
    </MantineProvider>
  );
  const result = render(view());
  result.container.querySelectorAll(".kodex-thread-pane-scroll").forEach((element) => {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1000, 700));
  });
  return { ...result, onAdd, update: (options: typeof props) => result.rerender(view(options)) };
}

function select(start: Node, end = start, startOffset = 0, endOffset = end.textContent?.length ?? 0) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

beforeEach(() => {
  // jsdom does not implement browser range geometry.
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: vi.fn(() => rect()) });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: vi.fn(() => [rect()]) });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AssistantSelectionAction", () => {
  it("adds literal captured text after action focus collapses the native selection", async () => {
    const { onAdd } = mount();
    const body = screen.getByTestId("assistant");
    select(body.firstChild!, body.firstChild!, 0, body.firstChild!.childNodes.length);
    const button = await screen.findByRole("button", { name: "Add to chat" });
    act(() => {
      button.focus();
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.click(button);
    expect(onAdd).toHaveBeenCalledWith("  Selected literal text.  ", null);
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it("accepts selections crossing formatting inside one assistant reply", async () => {
    mount();
    const paragraph = screen.getByTestId("assistant").firstChild!;
    select(paragraph.firstChild!, paragraph.lastChild!, 2, 5);
    expect(await screen.findByRole("button", { name: "Add to chat" })).toBeInTheDocument();
  });

  it("shows for keyboard selection even when only keyup is delivered", async () => {
    mount();
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("second"));
    window.getSelection()?.addRange(range);
    fireEvent.keyUp(document, { key: "ArrowRight", shiftKey: true });
    expect(await screen.findByRole("button", { name: "Add to chat" })).toBeInTheDocument();
  });

  it("adds touch selection without suppressing native touch or context-menu events", async () => {
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: query.includes("coarse") }));
    const { onAdd } = mount();
    select(screen.getByTestId("second").firstChild!);
    const button = await screen.findByRole("button", { name: "Add to chat" });
    expect(fireEvent.touchStart(screen.getByTestId("second"))).toBe(true);
    expect(fireEvent.contextMenu(screen.getByTestId("second"))).toBe(true);
    fireEvent.touchEnd(screen.getByTestId("second"));
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(onAdd).toHaveBeenCalledWith("Second reply", "touch");
  });

  it("hides when selection is cleared", async () => {
    mount();
    select(screen.getByTestId("second").firstChild!);
    await screen.findByRole("button", { name: "Add to chat" });
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it.each(["user", "subagent", "other"])("excludes selection from %s content", (target) => {
    mount();
    select(screen.getByTestId(target).firstChild!);
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it("excludes ranges crossing assistant replies", () => {
    mount();
    select(screen.getByTestId("assistant").firstChild!.firstChild!, screen.getByTestId("second").firstChild!);
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it("dismisses on Escape without reopening the same selection on scroll", async () => {
    mount();
    select(screen.getByTestId("second").firstChild!);
    await screen.findByRole("button", { name: "Add to chat" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.scroll(window);
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
    select(screen.getByTestId("assistant").firstChild!.firstChild!);
    expect(await screen.findByRole("button", { name: "Add to chat" })).toBeInTheDocument();
  });

  it("dismisses when interacting outside the action and selected reply", async () => {
    mount();
    select(screen.getByTestId("second").firstChild!);
    await screen.findByRole("button", { name: "Add to chat" });
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Message" }));
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it("hides on disabled or draft changes until a fresh selection", async () => {
    const { update } = mount({ draftKey: "first" });
    select(screen.getByTestId("second").firstChild!);
    await screen.findByRole("button", { name: "Add to chat" });
    update({ disabled: true, draftKey: "first" });
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
    update({ disabled: false, draftKey: "second" });
    fireEvent(document, new Event("selectionchange"));
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
    select(screen.getByTestId("assistant").firstChild!.firstChild!);
    expect(await screen.findByRole("button", { name: "Add to chat" })).toBeInTheDocument();
  });

  it("drops captured selection when its markdown is replaced", async () => {
    const { onAdd } = mount();
    const body = screen.getByTestId("assistant");
    select(body.firstChild!.firstChild!);
    await screen.findByRole("button", { name: "Add to chat" });
    act(() => { body.replaceChildren(document.createTextNode("Updated reply")); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument());
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("rejects a stale click before mutation observation runs", async () => {
    const { onAdd } = mount();
    const text = screen.getByTestId("second").firstChild!;
    select(text);
    const button = await screen.findByRole("button", { name: "Add to chat" });
    text.textContent = "Changed reply";
    fireEvent.click(button);
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it("follows timeline scrolling and hides when selected text is out of view", async () => {
    const { container } = mount();
    select(screen.getByTestId("second").firstChild!);
    const button = await screen.findByRole("button", { name: "Add to chat" });
    const toolbar = button.parentElement!;
    const before = toolbar.style.top;
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([rect(100, 150)] as unknown as DOMRectList);
    fireEvent.scroll(container.querySelector(".kodex-thread-pane-scroll")!);
    expect(toolbar.style.top).not.toBe(before);
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([rect(100, -100)] as unknown as DOMRectList);
    fireEvent.scroll(container.querySelector(".kodex-thread-pane-scroll")!);
    expect(screen.queryByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
  });

  it("clamps position to the visual viewport and follows viewport changes", async () => {
    const viewport = Object.assign(new EventTarget(), { offsetLeft: 20, offsetTop: 50, width: 320, height: 450 });
    vi.stubGlobal("visualViewport", viewport);
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([rect(300, 100)] as unknown as DOMRectList);
    mount();
    select(screen.getByTestId("second").firstChild!);
    const button = await screen.findByRole("button", { name: "Add to chat" });
    const toolbar = button.parentElement!;
    expect(Number.parseFloat(toolbar.style.left)).toBeLessThan(320);
    expect(Number.parseFloat(toolbar.style.top)).toBeGreaterThanOrEqual(58);
    act(() => { viewport.offsetTop = 80; viewport.dispatchEvent(new Event("scroll")); });
    expect(Number.parseFloat(toolbar.style.top)).toBeGreaterThanOrEqual(88);
  });
});
