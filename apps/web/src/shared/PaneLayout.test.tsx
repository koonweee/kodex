import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaneLayout, usePaneLayout } from "./PaneLayout";

const observers: { target?: Element; resize: (width: number, height: number) => void; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
function installObserver() {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    record: typeof observers[number];
    constructor(callback: ResizeObserverCallback) {
      this.record = { resize: (width, height) => callback([{ target: this.record.target!, borderBoxSize: [{ inlineSize: width, blockSize: height }], contentRect: { width, height } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver), disconnect: vi.fn() };
      observers.push(this.record);
    }
    observe(target: Element) { this.record.target = target; }
    disconnect() { this.record.disconnect(); }
  });
}
function Consumer({ name }: { name: string }) {
  const { compact, short } = usePaneLayout();
  return <output aria-label={name}>{`${compact}/${short}`}</output>;
}
afterEach(() => vi.unstubAllGlobals());
it("classifies sibling and nested panes independently and retains hidden pane measurements", () => {
  installObserver();
  const view = render(<><PaneLayout aria-label="outer"><Consumer name="outer state" /><PaneLayout aria-label="nested"><Consumer name="nested state" /></PaneLayout></PaneLayout><PaneLayout aria-label="sibling"><Consumer name="sibling state" /></PaneLayout></>);
  const resize = (label: string, width: number, height: number) => act(() => observers.find(o => o.target?.getAttribute("aria-label") === label)!.resize(width, height));
  resize("outer", 500, 800); resize("nested", 700, 400); resize("sibling", 1000, 900);
  expect(screen.getByLabelText("outer state")).toHaveTextContent("true/false");
  expect(screen.getByLabelText("nested state")).toHaveTextContent("false/true");
  expect(screen.getByLabelText("sibling state")).toHaveTextContent("false/false");
  resize("outer", 0, 0);
  expect(screen.getByLabelText("outer state")).toHaveTextContent("true/false");
  resize("outer", 900, 500);
  expect(screen.getByLabelText("outer state")).toHaveTextContent("false/true");
  view.unmount();
  expect(observers.every(o => o.disconnect.mock.calls.length === 1)).toBe(true);
});
