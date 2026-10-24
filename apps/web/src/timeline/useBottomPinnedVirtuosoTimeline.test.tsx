import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";

import { useBottomPinnedVirtuosoTimeline } from "./useBottomPinnedVirtuosoTimeline";

let frameTimestamp = 0;

describe("useBottomPinnedVirtuosoTimeline fullscreen recovery", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    frames = new Map();
    frameTimestamp = 0;
    nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores a pinned timeline after fullscreen collapses even when no resize callback arrives", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = document.createElement("div");
    Object.defineProperties(scrollParent, {
      clientHeight: { configurable: true, get: () => geometry.clientHeight },
      scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    });
    scrollParent.scrollTop = 600;
    document.body.append(scrollParent);

    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 20,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);
    expect(distanceFromBottom(scrollParent)).toBe(0);

    hook.rerender({ layoutTransitionActive: true });
    geometry.clientHeight = 800;
    geometry.scrollHeight = 800;
    scrollParent.scrollTop = 0;

    geometry.clientHeight = 355;
    geometry.scrollHeight = 1_200;
    hook.rerender({ layoutTransitionActive: false });
    expect(distanceFromBottom(scrollParent)).toBe(845);

    flushFrames(frames);
    expect(distanceFromBottom(scrollParent)).toBe(0);

    hook.unmount();
    scrollParent.remove();
  });

  it("protects pin state from a child layout measurement in the opening commit", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 600);
    let timeline: ReturnType<typeof useBottomPinnedVirtuosoTimeline> | null = null;
    const view = render(
      <TimelineTransitionHarness
        active={false}
        onTimeline={(value) => { timeline = value; }}
        scrollParent={scrollParent}
      />,
    );
    flushFrames(frames);

    view.rerender(
      <TimelineTransitionHarness
        active
        onTimeline={(value) => { timeline = value; }}
        scrollParent={scrollParent}
      />,
    );
    expect(timeline!.showScrollToBottom).toBe(false);

    geometry.clientHeight = 355;
    geometry.scrollHeight = 1_200;
    view.rerender(
      <TimelineTransitionHarness
        active={false}
        onTimeline={(value) => { timeline = value; }}
        scrollParent={scrollParent}
      />,
    );
    flushFrames(frames);

    expect(distanceFromBottom(scrollParent)).toBe(0);
    view.unmount();
    scrollParent.remove();
  });

  it("suppresses a stale geometry observer callback after fullscreen activates", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 600);
    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 20,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);
    const staleGeometryCallback = hook.result.current.handleTotalListHeightChanged;

    hook.rerender({ layoutTransitionActive: true });
    act(() => staleGeometryCallback(geometry.scrollHeight));

    expect(frames.size).toBe(0);
    expect(distanceFromBottom(scrollParent)).toBe(0);
    hook.unmount();
    scrollParent.remove();
  });

  it("recovers when the timeline mounts underneath an already-expanded composer", () => {
    const geometry = { clientHeight: 800, scrollHeight: 800 };
    const scrollParent = createScrollParent(geometry, 0);
    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 20,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: true } },
    );

    geometry.clientHeight = 355;
    geometry.scrollHeight = 1_200;
    hook.rerender({ layoutTransitionActive: false });
    flushFrames(frames);

    expect(distanceFromBottom(scrollParent)).toBe(0);
    expect(hook.result.current.showScrollToBottom).toBe(false);
    hook.unmount();
    scrollParent.remove();
  });

  it("does not reclaim the bottom when the user was reading earlier content", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = document.createElement("div");
    Object.defineProperties(scrollParent, {
      clientHeight: { configurable: true, get: () => geometry.clientHeight },
      scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    });
    scrollParent.scrollTop = 600;
    document.body.append(scrollParent);

    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 20,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);

    act(() => {
      scrollParent.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      scrollParent.scrollTop = 280;
      scrollParent.dispatchEvent(new Event("scroll"));
    });
    expect(hook.result.current.showScrollToBottom).toBe(true);

    hook.rerender({ layoutTransitionActive: true });
    geometry.clientHeight = 355;
    geometry.scrollHeight = 1_200;
    hook.rerender({ layoutTransitionActive: false });
    flushFrames(frames);

    expect(scrollParent.scrollTop).toBe(280);
    expect(distanceFromBottom(scrollParent)).toBe(565);

    hook.unmount();
    scrollParent.remove();
  });

  it("releases recovery when the user scrolls up after fullscreen collapses", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 600);
    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 20,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);

    hook.rerender({ layoutTransitionActive: true });
    geometry.clientHeight = 355;
    geometry.scrollHeight = 1_200;
    hook.rerender({ layoutTransitionActive: false });
    act(() => {
      scrollParent.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      scrollParent.scrollTop = 500;
      scrollParent.dispatchEvent(new Event("scroll"));
    });
    flushFrames(frames);

    expect(scrollParent.scrollTop).toBe(500);
    expect(distanceFromBottom(scrollParent)).toBe(345);
    hook.unmount();
    scrollParent.remove();
  });

  it("survives repeated fullscreen collapse and delayed geometry changes while pinned", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 600);
    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 80,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);

    for (let iteration = 0; iteration < 100; iteration += 1) {
      hook.rerender({ layoutTransitionActive: true });
      geometry.clientHeight = 800;
      geometry.scrollHeight = 800;
      scrollParent.scrollTop = 0;

      geometry.clientHeight = 355;
      geometry.scrollHeight = 1_200 + iteration;
      hook.rerender({ layoutTransitionActive: false });
      flushOneFrame(frames);

      geometry.clientHeight = 690;
      hook.result.current.handleTotalListHeightChanged(geometry.scrollHeight);
      flushOneFrame(frames);

      geometry.clientHeight = 637;
      geometry.scrollHeight += 17;
      hook.result.current.handleTotalListHeightChanged(geometry.scrollHeight);
      flushFrames(frames);
      expect(distanceFromBottom(scrollParent)).toBe(0);
    }

    hook.unmount();
    scrollParent.remove();
  });

  it("repins a later non-user scroll correction after transition recovery", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 600);
    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 20,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);
    hook.rerender({ layoutTransitionActive: true });
    geometry.clientHeight = 355;
    geometry.scrollHeight = 1_200;
    hook.rerender({ layoutTransitionActive: false });
    flushFrames(frames);
    expect(distanceFromBottom(scrollParent)).toBe(0);

    act(() => {
      scrollParent.scrollTop -= 180;
      scrollParent.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scrollParent)).toBe(180);
    flushFrames(frames);

    expect(distanceFromBottom(scrollParent)).toBe(0);
    expect(hook.result.current.showScrollToBottom).toBe(false);
    hook.unmount();
    scrollParent.remove();
  });

  it("bounds recovery when an empty timeline cannot reach the scroll parent bottom", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 0);
    const hook = renderHook(
      ({ layoutTransitionActive }) => useBottomPinnedVirtuosoTimeline({
        layoutTransitionActive,
        onReady: vi.fn(),
        rowCount: 0,
        scrollParentElement: scrollParent,
        threadId: "thread-1",
      }),
      { initialProps: { layoutTransitionActive: false } },
    );
    flushFrames(frames);
    hook.rerender({ layoutTransitionActive: true });
    hook.rerender({ layoutTransitionActive: false });
    flushFrames(frames, 120);

    expect(frames.size).toBe(0);
    expect(scrollParent.scrollTop).toBe(0);
    hook.unmount();
    scrollParent.remove();
  });

  it("does not replace an explicit smooth scroll with an automatic follow", () => {
    const geometry = { clientHeight: 400, scrollHeight: 1_000 };
    const scrollParent = createScrollParent(geometry, 600);
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      const top = typeof options === "number" ? options : options?.top ?? 0;
      scrollParent.scrollTop = top - 120;
      scrollParent.dispatchEvent(new Event("scroll"));
    });
    scrollParent.scrollTo = scrollTo as typeof scrollParent.scrollTo;
    const hook = renderHook(() => useBottomPinnedVirtuosoTimeline({
      onReady: vi.fn(),
      rowCount: 20,
      scrollParentElement: scrollParent,
      threadId: "thread-1",
    }));
    flushFrames(frames);
    act(() => {
      scrollParent.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      scrollParent.scrollTop = 400;
      scrollParent.dispatchEvent(new Event("scroll"));
    });

    act(() => hook.result.current.scrollToBottom());
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });
    expect(distanceFromBottom(scrollParent)).toBe(120);
    flushFrames(frames);

    expect(distanceFromBottom(scrollParent)).toBe(120);
    hook.unmount();
    scrollParent.remove();
  });
});

function TimelineTransitionHarness({
  active,
  onTimeline,
  scrollParent,
}: {
  active: boolean;
  onTimeline: (timeline: ReturnType<typeof useBottomPinnedVirtuosoTimeline>) => void;
  scrollParent: HTMLDivElement;
}) {
  const timeline = useBottomPinnedVirtuosoTimeline({
    layoutTransitionActive: active,
    onReady: () => undefined,
    rowCount: 20,
    scrollParentElement: scrollParent,
    threadId: "thread-1",
  });
  onTimeline(timeline);
  return <ChildLayoutMeasurement active={active} onAtBottomStateChange={timeline.handleAtBottomStateChange} />;
}

function ChildLayoutMeasurement({
  active,
  onAtBottomStateChange,
}: {
  active: boolean;
  onAtBottomStateChange: (atBottom: boolean) => void;
}) {
  useLayoutEffect(() => {
    if (active) onAtBottomStateChange(false);
  }, [active, onAtBottomStateChange]);
  return null;
}

function createScrollParent(geometry: { clientHeight: number; scrollHeight: number }, scrollTop: number) {
  const scrollParent = document.createElement("div");
  Object.defineProperties(scrollParent, {
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
  });
  scrollParent.scrollTop = scrollTop;
  document.body.append(scrollParent);
  return scrollParent;
}

function flushOneFrame(frames: Map<number, FrameRequestCallback>) {
  frameTimestamp += 16;
  act(() => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(frameTimestamp);
  });
}

function flushFrames(frames: Map<number, FrameRequestCallback>, limit = 40) {
  act(() => {
    for (let index = 0; index < limit && frames.size > 0; index += 1) {
      const pending = [...frames.entries()];
      frames.clear();
      frameTimestamp += 16;
      for (const [, callback] of pending) callback(frameTimestamp);
    }
  });
}

function distanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.clientHeight - element.scrollTop;
}
