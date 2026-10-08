import { useLayoutEffect, useRef, type RefObject } from "react";

type Bounds = Pick<DOMRect, "left" | "top" | "bottom" | "width" | "height">;
type Layout = {
  idle: boolean;
  shadow: HTMLElement;
  surface: HTMLElement;
  bounds: Bounds;
  radius: number;
  parts: Map<HTMLElement, Bounds>;
};
type Motion = { from: Layout; to: Layout; surface: Animation; animations: Animation[] };
const partsSelector = [
  ".kodex-composer-textarea",
  ".kodex-composer-attachment-target",
  ".kodex-composer-control-slot",
  ".kodex-composer-toolbar-left > .kodex-adaptive-icon-button",
  ".kodex-composer-action",
].join(", ");
const timing: KeyframeAnimationOptions = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" };
const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;

function blendBounds(from: Bounds, to: Bounds, progress: number): Bounds {
  return {
    left: mix(from.left, to.left, progress), top: mix(from.top, to.top, progress),
    bottom: mix(from.bottom, to.bottom, progress), width: mix(from.width, to.width, progress),
    height: mix(from.height, to.height, progress),
  };
}

function currentLayout(motion: Motion): Layout {
  // Native progress already includes easing; no animation-frame JS is needed.
  const progress = motion.surface.effect?.getComputedTiming().progress ?? 1;
  return {
    ...motion.to,
    bounds: blendBounds(motion.from.bounds, motion.to.bounds, progress),
    radius: mix(motion.from.radius, motion.to.radius, progress),
    parts: new Map([...motion.to.parts].map(([element, bounds]) => [
      element, blendBounds(motion.from.parts.get(element) ?? bounds, bounds, progress),
    ])),
  };
}

export function createInlineComposerMotion(form: HTMLElement) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let previous: Layout | null = null;
  let motion: Motion | null = null;
  let enabled = false;
  let idle = false;

  function stop() {
    const animations = motion?.animations ?? [];
    motion = null;
    for (const animation of animations) animation.cancel();
  }

  function measure(): Layout | null {
    const shadow = form.querySelector<HTMLElement>(".kodex-composer-shadow");
    const surface = form.querySelector<HTMLElement>(".kodex-composer-surface");
    const bounds = form.getBoundingClientRect();
    if (!shadow || !surface || bounds.width <= 0 || bounds.height <= 0) return null;
    // Short pills normalize 32px corners to half their height in the browser.
    const radius = Math.min(parseFloat(getComputedStyle(form).borderTopLeftRadius), bounds.width / 2, bounds.height / 2);
    return { idle, shadow, surface, bounds, radius, parts: new Map(
      [...form.querySelectorAll<HTMLElement>(partsSelector)].map(element => [element, element.getBoundingClientRect()]),
    ) };
  }

  function update(nextEnabled: boolean, nextIdle: boolean) {
    enabled = nextEnabled;
    idle = nextIdle;
    if (!enabled || reducedMotion.matches || typeof form.animate !== "function") {
      stop();
      previous = enabled ? measure() : null;
      return;
    }
    const bounds = form.getBoundingClientRect();
    if (previous?.idle === idle) {
      // Ordinary typing/rerenders must not restart or stop a valid transition.
      // Real form resize/autosize changes invalidate the destination geometry.
      const target = motion?.to.bounds;
      if (target && ["left", "top", "width", "height"].every(key =>
        Math.abs(bounds[key as keyof Bounds] - target[key as keyof Bounds]) < 0.5)) return;
      stop();
      previous = measure();
      return;
    }
    const from = motion ? currentLayout(motion) : previous;
    stop(); // Read destination widths only after removing animation overrides.
    const to = measure();
    previous = to;
    if (!from || !to || Math.abs(from.bounds.width - to.bounds.width) > 0.5) return;

    const scaleX = from.bounds.width / to.bounds.width;
    const scaleY = from.bounds.height / to.bounds.height;
    const dx = from.bounds.left - to.bounds.left;
    const dy = from.bounds.bottom - to.bounds.bottom;
    // Correct elliptical radii along the scale, so the background can stretch
    // independently without stretching text or producing visibly tall corners.
    const surface = to.surface.animate([0, 0.25, 0.5, 0.75, 1].map(progress => {
      const x = mix(scaleX, 1, progress);
      const y = mix(scaleY, 1, progress);
      const radius = mix(from.radius, to.radius, progress);
      return {
        offset: progress, transform: `translate(${mix(dx, 0, progress)}px, ${mix(dy, 0, progress)}px) scale(${x}, ${y})`,
        borderRadius: `${radius / x}px / ${radius / y}px`,
      };
    }), timing);
    // Animate shadow geometry without scaling it, so its blur and offset stay
    // visually constant while the fill uses a compositor transform.
    const shadow = to.shadow.animate([0, 0.25, 0.5, 0.75, 1].map(progress => ({
      offset: progress,
      height: `${mix(from.bounds.height, to.bounds.height, progress)}px`,
      transform: `translate(${mix(dx, 0, progress)}px, ${mix(dy, 0, progress)}px)`,
      borderRadius: `${mix(from.radius, to.radius, progress)}px`,
    })), timing);
    const animations = [surface, shadow];
    for (const [element, destination] of to.parts) {
      const start = from.parts.get(element);
      if (!start || start.width <= 0 || destination.width <= 0) continue;
      const x = start.left - destination.left;
      const y = start.top - destination.top;
      const field = element.classList.contains("kodex-composer-textarea");
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && (!field || Math.abs(start.width - destination.width) < 0.5)) continue;
      animations.push(element.animate([
        { transform: `translate(${x}px, ${y}px)`, ...(field ? { width: `${start.width}px` } : {}) },
        { transform: "translate(0px, 0px)", ...(field ? { width: `${destination.width}px` } : {}) },
      ], timing));
    }
    const started: Motion = { from, to, surface, animations };
    motion = started;
    void surface.finished.then(() => {
      if (motion === started) { stop(); previous = measure(); }
    }, () => undefined);
  }

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update(enabled, idle));
  observer?.observe(form);
  const onReducedMotion = () => { stop(); previous = null; update(enabled, idle); };
  reducedMotion.addEventListener("change", onReducedMotion);
  return {
    update,
    dispose() { stop(); observer?.disconnect(); reducedMotion.removeEventListener("change", onReducedMotion); previous = null; },
  };
}

export function useInlineComposerMotion(formRef: RefObject<HTMLFormElement | null>, enabled: boolean, idle: boolean) {
  const controller = useRef<ReturnType<typeof createInlineComposerMotion> | null>(null);
  useLayoutEffect(() => {
    if (!formRef.current) return;
    controller.current = createInlineComposerMotion(formRef.current);
    return () => { controller.current?.dispose(); controller.current = null; };
  }, [formRef]);
  useLayoutEffect(() => { controller.current?.update(enabled, idle); });
}
