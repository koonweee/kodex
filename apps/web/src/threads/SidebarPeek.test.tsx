import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarPeek } from "./SidebarPeek";

function view(enabled = true, showAction = true) {
  return <MantineProvider env="test"><SidebarPeek enabled={enabled} collapsed
    rail={(handlers) => <button {...handlers}>Expand</button>}>
    {showAction && <button>Sidebar action</button>}
    {createPortal(<button>Portal action</button>, document.body)}
  </SidebarPeek><button>Pane action</button></MantineProvider>;
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("sidebar peek", () => {
  it("delays opening, cancels brief hovers and closes after leaving", () => {
    vi.useFakeTimers();
    render(view());
    const trigger = screen.getByRole("button", { name: "Expand" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    advance(100);
    expect(screen.queryByRole("button", { name: "Sidebar action" })).toBeNull();
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    advance(300);
    expect(screen.queryByRole("button", { name: "Sidebar action" })).toBeNull();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    advance(400);
    expect(screen.getByRole("button", { name: "Sidebar action" })).toBeVisible();
    fireEvent.pointerLeave(screen.getByText("Expand").parentElement!, { pointerType: "mouse" });
    advance(200);
    expect(screen.getByRole("button", { name: "Sidebar action" })).toBeVisible();
    advance(500);
    expect(screen.queryByRole("button", { name: "Sidebar action" })).toBeNull();
  });
  it("retains keyboard focus in owned portals until focus leaves", () => {
    vi.useFakeTimers();
    render(view());
    fireEvent.pointerEnter(screen.getByText("Expand"), { pointerType: "mouse" });
    advance(400);
    act(() => screen.getByText("Portal action").focus());
    fireEvent.pointerLeave(screen.getByText("Expand").parentElement!, { pointerType: "mouse" });
    advance(700);
    expect(screen.getByText("Sidebar action")).toBeVisible();
    act(() => screen.getByText("Pane action").focus());
    advance(700);
    expect(screen.queryByText("Sidebar action")).toBeNull();
  });
  it("closes after a focused row is removed without a blur event", () => {
    vi.useFakeTimers();
    const rendered = render(view());
    fireEvent.pointerEnter(screen.getByText("Expand"), { pointerType: "mouse" });
    advance(400);
    act(() => screen.getByText("Sidebar action").focus());
    rendered.rerender(view(true, false));
    expect(document.activeElement).toBe(document.body);
    fireEvent.pointerLeave(screen.getByText("Expand").parentElement!, { pointerType: "mouse" });
    advance(700);
    expect(screen.queryByText("Portal action")).toBeNull();
  });
  it("keeps the preview mounted during a drag and closes when it ends outside", () => {
    vi.useFakeTimers();
    render(view());
    fireEvent.pointerEnter(screen.getByText("Expand"), { pointerType: "mouse" });
    advance(400);
    const action = screen.getByText("Sidebar action");
    fireEvent.dragStart(action);
    fireEvent.pointerLeave(screen.getByText("Expand").parentElement!, { pointerType: "mouse" });
    advance(700);
    expect(action).toBeVisible();
    fireEvent.dragEnd(action);
    advance(700);
    expect(screen.queryByText("Sidebar action")).toBeNull();
  });
  it("does not peek when hover is unavailable", () => {
    vi.useFakeTimers();
    render(view(false));
    fireEvent.pointerEnter(screen.getByText("Expand"), { pointerType: "mouse" });
    advance(1000);
    expect(screen.queryByText("Sidebar action")).toBeNull();
  });
});
