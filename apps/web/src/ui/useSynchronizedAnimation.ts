import { useLayoutEffect, useRef } from "react";

// CSS owns timing and reduced motion. Align only when an animation is created,
// so late mounts share the document clock without timers or per-frame updates.
export function useSynchronizedAnimation<T extends Element>(identity?: unknown) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element?.getAnimations) return;
    const synchronize = () => {
      for (const animation of element.getAnimations({ subtree: true })) {
        if (animation.playState === "running" && animation.startTime !== 0) {
          animation.startTime = 0;
        }
      }
    };
    synchronize();
    // Includes CSS restarts after display changes or a live reduced-motion change.
    element.addEventListener("animationstart", synchronize);
    return () => element.removeEventListener("animationstart", synchronize);
  }, [identity]);
  return ref;
}
