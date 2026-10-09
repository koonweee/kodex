import { afterEach, expect, it, vi } from "vitest";
import { createInlineComposerMotion } from "./useInlineComposerMotion";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });

function fixture() {
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  const observers: ResizeObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect = disconnect;
  });
  const form = document.createElement("form");
  form.innerHTML = '<div class="kodex-composer-shadow"></div><div class="kodex-composer-surface"></div><div class="kodex-composer-textarea"><textarea></textarea></div>';
  document.body.append(form);
  let idle = true;
  let width = 360;
  const shadow = form.firstElementChild as HTMLElement;
  const surface = form.children[1] as HTMLElement;
  const field = form.lastElementChild as HTMLElement;
  const animations: { node: HTMLElement; frames: Keyframe[]; animation: Animation; cancel: ReturnType<typeof vi.fn>; progress: number; finish: () => void }[] = [];
  for (const node of [form, shadow, surface, field]) {
    node.getBoundingClientRect = () => {
      const height = idle ? 60 : 110;
      return node === field ? new DOMRect(idle ? 60 : 10, idle ? 648 : 598, idle ? 150 : width - 20, 44)
        : new DOMRect(0, 700 - height, width, height);
    };
    node.animate = (frames) => {
      let finish!: () => void;
      const finished = new Promise<Animation>(resolve => { finish = () => resolve(record.animation); });
      const cancel = vi.fn();
      const record = { node, frames: frames as Keyframe[], animation: {} as Animation, cancel, progress: 0, finish: () => finish() };
      record.animation = { cancel, finished, effect: { getComputedTiming: () => ({ progress: record.progress }) } } as unknown as Animation;
      animations.push(record);
      return record.animation;
    };
  }
  const controller = createInlineComposerMotion(form);
  disposers.push(() => { controller.dispose(); form.remove(); });
  const setIdle = (next: boolean) => { idle = next; form.style.borderRadius = next ? "32px" : "24px"; };
  setIdle(true);
  controller.update(true, true);
  return { controller, animations, form, shadow, surface, field, media, disconnect, setIdle,
    resize(next: number) { width = next; observers[0]([], {} as ResizeObserver); } };
}

it("keeps the original editable field usable and does not restart motion for typing rerenders", () => {
  const f = fixture();
  const input = f.field.querySelector("textarea")!;
  f.setIdle(false);
  input.focus();
  f.controller.update(true, false);
  const count = f.animations.length;
  expect(count).toBeGreaterThan(0);
  input.value = "Draft during motion";
  input.setSelectionRange(2, 7);
  f.controller.update(true, false);
  expect(f.animations).toHaveLength(count);
  expect(f.animations.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
  expect(document.activeElement).toBe(input);
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(["Draft during motion", 2, 7]);
});

it("reverses from the eased visible geometry instead of jumping to an endpoint", () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.update(true, false);
  const first = [...f.animations];
  first.forEach(record => { record.progress = 0.4; });
  f.setIdle(true);
  f.controller.update(true, true);
  expect(first.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
  const restarted = f.animations[first.length];
  expect(restarted.node).toBe(f.surface);
  const transform = String(restarted.frames[0].transform);
  const scaleY = Number(transform.match(/scale\([^,]+, ([^)]+)\)/)![1]);
  const visibleHeight = 60 + (110 - 60) * 0.4;
  expect(scaleY * 60).toBeCloseTo(visibleHeight);
  const field = f.animations.slice(first.length).find(record => record.node === f.field)!;
  expect(parseFloat(String(field.frames[0].width))).toBeCloseTo(150 + (340 - 150) * 0.4);
});

it("animates shadow geometry without scaling its blur layer", () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.update(true, false);
  const shadow = f.animations.find(record => record.node === f.shadow)!;
  for (const frame of shadow.frames) {
    expect(frame.height).toBeDefined();
    expect(frame.borderRadius).toBeDefined();
    expect(String(frame.transform)).not.toContain("scale");
  }
});

it("cancels stale geometry after resize and does not animate the new layout", () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.update(true, false);
  const count = f.animations.length;
  f.resize(420);
  expect(f.animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
  f.controller.update(true, false);
  expect(f.animations).toHaveLength(count);
});

it("cancels immediately when reduced motion becomes enabled and removes listeners on disposal", () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.update(true, false);
  f.media.matches = true;
  const listener = f.media.addEventListener.mock.calls[0][1] as () => void;
  listener();
  expect(f.animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
  const count = f.animations.length;
  f.setIdle(true);
  f.controller.update(true, true);
  expect(f.animations).toHaveLength(count);
  f.controller.dispose();
  expect(f.disconnect).toHaveBeenCalled();
  expect(f.media.removeEventListener).toHaveBeenCalledWith("change", listener);
});

it("clears native overrides at completion and ignores completion of an obsolete animation", async () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.update(true, false);
  const first = f.animations[0];
  first.progress = 0.5;
  f.setIdle(true);
  f.controller.update(true, true);
  const current = f.animations.filter(record => record.cancel.mock.calls.length === 0);
  first.finish();
  await Promise.resolve();
  expect(current.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true);
  current[0].finish();
  await Promise.resolve();
  expect(current.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
});

it("leaves fullscreen, regular and draft presentations immediate", () => {
  const f = fixture();
  f.setIdle(false);
  f.controller.update(false, false);
  expect(f.animations).toHaveLength(0);
  f.controller.update(true, false);
  expect(f.animations).toHaveLength(0);
});
