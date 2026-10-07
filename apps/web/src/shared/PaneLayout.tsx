import { createContext, useContext, useLayoutEffect, useRef, useState, type HTMLAttributes, type Ref } from "react";

// Fit thresholds belong to the pane, independently of viewport and input devices.
const COMPACT_PANE_WIDTH = 640;
const SHORT_PANE_HEIGHT = 600;
type PaneClassification = { compact: boolean; short: boolean };
const regular: PaneClassification = { compact: false, short: false };
const PaneLayoutContext = createContext<PaneClassification>(regular);

export function usePaneLayout() {
  return useContext(PaneLayoutContext);
}

export function PaneLayout({ component: Component = "div", children, ...props }: HTMLAttributes<HTMLElement> & { component?: "div" | "section" | "aside" }) {
  const root = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState(regular);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = (width: number, height: number) => {
      // Dockview hides inactive tabs; retain their last useful classification.
      if (width <= 0 || height <= 0) return;
      const compact = width <= COMPACT_PANE_WIDTH;
      const short = height < SHORT_PANE_HEIGHT;
      setLayout(previous => previous.compact === compact && previous.short === short ? previous : { compact, short });
    };
    const bounds = element.getBoundingClientRect();
    measure(bounds.width, bounds.height);
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(candidate => candidate.target === element);
      if (!entry) return;
      const box = entry.borderBoxSize?.[0];
      const bounds = box ? { width: box.inlineSize, height: box.blockSize } : element.getBoundingClientRect();
      measure(bounds.width, bounds.height);
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return <PaneLayoutContext.Provider value={layout}>
    <Component {...props} ref={root as Ref<HTMLDivElement>} data-pane-width={layout.compact ? "compact" : "regular"} data-pane-height={layout.short ? "short" : "regular"}>{children}</Component>
  </PaneLayoutContext.Provider>;
}
