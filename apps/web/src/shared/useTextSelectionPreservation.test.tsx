import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { useTextSelectionPreservation } from "./useTextSelectionPreservation";

function Pane({ id, prefix = false, revision = 0 }: { id: string; prefix?: boolean; revision?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useTextSelectionPreservation(rootRef, revision);
  return (
    <div data-testid={id} ref={rootRef}>
      {prefix ? <div data-row-key={`${id}-prefix`}>Inserted before the selected row.</div> : null}
      <div data-row-key={`${id}-answer`} key={revision}>Alpha selected suffix omega</div>
    </div>
  );
}

function selectSuffix(container: HTMLElement) {
  const node = container.querySelector<HTMLElement>("[data-row-key$='-answer']")!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 6);
  range.setEnd(node, 21);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("useTextSelectionPreservation", () => {
  it("keeps a selection on its stable row when content is prepended", () => {
    const view = render(<Pane id="first" />);
    const originalRow = view.getByTestId("first").querySelector("[data-row-key='first-answer']");
    selectSuffix(view.getByTestId("first"));

    view.rerender(<Pane id="first" prefix revision={1} />);

    expect(view.getByTestId("first").querySelector("[data-row-key='first-answer']")).not.toBe(originalRow);
    expect(window.getSelection()?.toString()).toBe("selected suffix");
  });

  it("does not steal a selection that moves to another pane", async () => {
    const view = render(<><Pane id="first" /><Pane id="second" /></>);
    selectSuffix(view.getByTestId("first"));
    selectSuffix(view.getByTestId("second"));

    view.rerender(<><Pane id="first" prefix revision={1} /><Pane id="second" /></>);
    await act(async () => {});

    expect(window.getSelection()?.toString()).toBe("selected suffix");
    expect(view.getByTestId("second").contains(window.getSelection()?.anchorNode ?? null)).toBe(true);
  });

  it("does not resurrect a selection collapsed from the keyboard", async () => {
    const view = render(<Pane id="first" />);
    selectSuffix(view.getByTestId("first"));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    window.getSelection()?.collapseToEnd();
    document.dispatchEvent(new Event("selectionchange"));

    view.rerender(<Pane id="first" prefix revision={1} />);
    await act(async () => {});

    expect(window.getSelection()?.isCollapsed).toBe(true);
  });
});
