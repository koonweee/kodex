import { Box, Transition } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { useEffect, useRef, useState, type PointerEventHandler, type ReactNode } from "react";
import "./sidebarPeek.css";

type TriggerHandlers = {
  onPointerEnter: PointerEventHandler<HTMLButtonElement>;
  onPointerLeave: PointerEventHandler<HTMLButtonElement>;
};

// The rail keeps the shell's layout width; this preview is per-tab presentation only.
// React events also bubble from owned portals, keeping menus inside this boundary.
export function SidebarPeek({ collapsed, enabled, rail, children }: {
  collapsed: boolean;
  enabled: boolean;
  rail: (handlers: TriggerHandlers) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerInside = useRef(false);
  const focusedElement = useRef<EventTarget | null>(null);
  const dragging = useRef(false);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const active = collapsed && enabled;
  function cancelOpen() { clearTimeout(openTimer.current); }
  function cancelClose() { clearTimeout(closeTimer.current); }
  function scheduleClose() {
    cancelOpen();
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pointerInside.current && !dragging.current && document.activeElement !== focusedElement.current) setOpen(false);
    }, 300);
  }
  useEffect(() => {
    if (!active) {
      setOpen(false);
      pointerInside.current = false;
      focusedElement.current = null;
      dragging.current = false;
    }
    return () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); };
  }, [active]);

  if (!collapsed) return children;
  return <Box ref={boundaryRef} className="kodex-sidebar-peek-boundary"
    onPointerEnter={(event) => {
      if (event.pointerType === "touch") return;
      pointerInside.current = true;
      cancelClose();
    }}
    onPointerLeave={() => { pointerInside.current = false; scheduleClose(); }}
    onFocusCapture={(event) => { focusedElement.current = event.target; cancelClose(); }}
    onBlurCapture={() => { focusedElement.current = null; scheduleClose(); }}
    onDragStartCapture={() => { dragging.current = true; cancelClose(); }}
    onDragEndCapture={() => { dragging.current = false; scheduleClose(); }}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !open ||
        (event.target instanceof Element && event.target.closest('[role="menu"]'))) return;
      event.preventDefault();
      setOpen(false);
      boundaryRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }}>
    {rail({
      onPointerEnter: (event) => {
        if (!active || event.pointerType === "touch") return;
        cancelOpen();
        cancelClose();
        openTimer.current = setTimeout(() => setOpen(true), 200);
      },
      onPointerLeave: cancelOpen,
    })}
    <Transition mounted={active && open} duration={reducedMotion ? 0 : 140} timingFunction="ease-out"
      transition={{ in: { opacity: 1, transform: "translateX(0)" }, out: { opacity: 0, transform: "translateX(-8px)" },
        common: {}, transitionProperty: "transform, opacity" }}>
      {(style) => <Box className="kodex-sidebar-peek-panel" style={style}>{children}</Box>}
    </Transition>
  </Box>;
}
