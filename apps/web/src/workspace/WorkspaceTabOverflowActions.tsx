import { Menu } from "@mantine/core";
import type { IDockviewHeaderActionsProps } from "dockview";
import { useCallback, useEffect, useRef, useState } from "react";

export function WorkspaceTabOverflowActions({ activePanel, panels }: IDockviewHeaderActionsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [overflowPanelIds, setOverflowPanelIds] = useState<string[]>([]);
  const measureOverflow = useCallback(() => {
    const root = rootRef.current;
    const header = root?.closest(".dv-tabs-and-actions-container");
    const tabsContainer = header?.querySelector<HTMLElement>(".dv-tabs-container");
    if (!tabsContainer) {
      setOverflowPanelIds([]);
      return;
    }
    tabsContainer.toggleAttribute("data-overflow-left", tabsContainer.scrollLeft > 1);
    tabsContainer.toggleAttribute("data-overflow-right", tabsContainer.scrollWidth - tabsContainer.clientWidth - tabsContainer.scrollLeft > 1);
    const containerRect = tabsContainer.getBoundingClientRect();
    const tabElements = Array.from(tabsContainer.querySelectorAll<HTMLElement>(":scope > .dv-tab"));
    const nextIds = panels.flatMap((panel, index) => {
      const tabElement = tabElements[index];
      if (!tabElement) {
        return [];
      }
      const tabRect = tabElement.getBoundingClientRect();
      return tabRect.right <= containerRect.left || tabRect.left >= containerRect.right ? [panel.id] : [];
    });
    setOverflowPanelIds((current) =>
      current.length === nextIds.length && current.every((id, index) => id === nextIds[index])
        ? current
        : nextIds,
    );
  }, [panels]);

  useEffect(() => {
    const root = rootRef.current;
    const header = root?.closest(".dv-tabs-and-actions-container");
    const tabsContainer = header?.querySelector<HTMLElement>(".dv-tabs-container");
    const frame = window.requestAnimationFrame(measureOverflow);
    if (!header || !tabsContainer || typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(tabsContainer);
    observer.observe(header);
    tabsContainer.addEventListener("scroll", measureOverflow, { passive: true });
    window.addEventListener("resize", measureOverflow);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      tabsContainer.removeEventListener("scroll", measureOverflow);
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow]);

  const overflowPanels = panels.filter((panel) => overflowPanelIds.includes(panel.id));
  return (
    <div className="kodex-workspace-tab-overflow" ref={rootRef}>
      {overflowPanels.length > 0 ? (
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <button aria-label="More tabs" className="kodex-workspace-tab-overflow-button" type="button">
              +{overflowPanels.length}
            </button>
          </Menu.Target>
          <Menu.Dropdown aria-label="More tabs" className="kodex-workspace-tab-overflow-menu">
            {overflowPanels.map((panel) => (
              <Menu.Item
                aria-current={panel.id === activePanel?.id ? "page" : undefined}
                className="kodex-workspace-tab-overflow-item"
                key={panel.id}
                onClick={() => {
                  panel.focus();
                }}
              >
                {panel.title ?? panel.id}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      ) : null}
    </div>
  );
}
