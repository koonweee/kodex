import { useRef } from "react";

export function useTimelineScrollParent(scrollParentElement: HTMLDivElement | null) {
  const measuredParent = useRef<HTMLDivElement | null>(null);
  if (measuredParent.current !== scrollParentElement) {
    measuredParent.current = null;
  }
  if (scrollParentElement && scrollParentElement.clientHeight > 0) {
    measuredParent.current = scrollParentElement;
  }
  // Hidden panes report zero height. Keep their established scroller so returning
  // to the pane does not restart Virtuoso's initial bottom alignment.
  return measuredParent.current;
}
