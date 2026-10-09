import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
type Gesture = { pointerId: number; x: number; y: number };

export function useQueueHold({ enabled, onQueue }: { enabled: boolean; onQueue: () => void }) {
  const [holding, setHolding] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const current = useRef({ enabled, onQueue });
  current.current = { enabled, onQueue };

  function clearTimer() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }
  function cancel(blockClick: boolean) {
    if (!gesture.current) return;
    clearTimer();
    gesture.current = null;
    setHolding(false);
    if (blockClick) suppressClick.current = true;
  }
  useEffect(() => {
    if (!enabled) cancel(true);
  }, [enabled]);
  useEffect(() => () => { clearTimer(); gesture.current = null; }, []);

  return {
    holding,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.isPrimary === false) return;
        suppressClick.current = false;
        if (!current.current.enabled || event.button !== 0) return;
        clearTimer();
        gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        setHolding(true);
        timer.current = setTimeout(() => {
          timer.current = null;
          if (!current.current.enabled || !gesture.current) return;
          suppressClick.current = true;
          setHolding(false);
          current.current.onQueue();
        }, HOLD_MS);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const active = gesture.current;
        if (active && event.pointerId === active.pointerId && Math.hypot(event.clientX - active.x, event.clientY - active.y) > MOVE_TOLERANCE) cancel(true);
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        if (event.pointerId === gesture.current?.pointerId) cancel(false);
      },
      onPointerLeave() { cancel(true); },
      onPointerCancel() { cancel(true); },
      onClick(event: MouseEvent<HTMLButtonElement>) {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown() { suppressClick.current = false; },
      onContextMenu(event: MouseEvent<HTMLButtonElement>) {
        if (gesture.current || suppressClick.current) event.preventDefault();
      },
    },
  };
}
