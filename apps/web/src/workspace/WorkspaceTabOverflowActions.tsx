import { AnimatedNumber } from "../ui/AnimatedNumber";
import { Menu } from "@mantine/core";
import type { IDockviewHeaderActionsProps } from "dockview";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { visibleWorkspaceTabs } from "./visibleWorkspaceTabs";

export function WorkspaceTabOverflowActions({ activePanel, panels }: IDockviewHeaderActionsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visibleIdsRef = useRef<string[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [overflowPanelIds, setOverflowPanelIds] = useState<string[]>([]);
  const [opened, setOpened] = useState(false);
  const [, refreshTitles] = useState(0);

  useEffect(() => {
    const subscriptions = panels.map(panel => panel.api.onDidTitleChange(() => refreshTitles(value => value + 1)));
    return () => subscriptions.forEach(subscription => subscription.dispose());
  }, [panels]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = root?.closest<HTMLElement>(".dv-tabs-and-actions-container");
    const tabs = header?.querySelector<HTMLElement>(".dv-tabs-container");
    const rightActions = header?.querySelector<HTMLElement>(".dv-right-actions-container");
    const button = buttonRef.current;
    if (!header || !tabs || !button) return;
    let frame = 0;
    const measure = () => {
      if (header.clientWidth <= 0) return; // Preserve hidden/maximized groups until revealed.
      const elements = Array.from(tabs.querySelectorAll<HTMLElement>(":scope > .dv-tab"));
      const entries = elements.flatMap(element => {
        const id = element.querySelector<HTMLElement>(".kodex-workspace-tab")?.dataset.paneId;
        return id ? [{ id, element }] : [];
      });
      if (!entries.length) return;
      const style = getComputedStyle(tabs);
      const tabStyle = getComputedStyle(entries[0].element);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const gap = pixels(style.columnGap);
      const minimumTabWidth = pixels(style.getPropertyValue("--kodex-workspace-tab-min-width"))
        + pixels(tabStyle.marginLeft) + pixels(tabStyle.marginRight);
      const available = header.clientWidth - (rightActions?.getBoundingClientRect().width ?? 0)
        - pixels(style.paddingLeft) - pixels(style.paddingRight);
      const allFit = entries.length * minimumTabWidth + (entries.length - 1) * gap <= available;
      const capacity = allFit ? entries.length
        : Math.floor((available - button.getBoundingClientRect().width + gap) / (minimumTabWidth + gap));
      const ids = entries.map(entry => entry.id);
      visibleIdsRef.current = visibleWorkspaceTabs(ids, activePanel?.id, capacity, visibleIdsRef.current);
      const visible = new Set(visibleIdsRef.current);
      // Hide header wrappers only; native panels, tab order and editor DOM remain intact.
      tabs.dataset.fixedTabCount = String(visible.size);
      entries.forEach(({ id, element }) => { element.hidden = !visible.has(id); });
      tabs.scrollLeft = 0;
      const next = ids.filter(id => !visible.has(id));
      setOverflowPanelIds(current => current.length === next.length && current.every((id, index) => id === next[index]) ? current : next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(header);
    observer.observe(button);
    if (rightActions) observer.observe(rightActions);
    // Native reordering and asynchronously mounted tab renderers can change
    // the header without changing its allocated size.
    const mutations = new MutationObserver(schedule);
    mutations.observe(tabs, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      delete tabs.dataset.fixedTabCount;
      tabs.querySelectorAll<HTMLElement>(":scope > .dv-tab").forEach(tab => { tab.hidden = false; });
    };
  }, [activePanel?.id, panels]);

  const overflowPanels = overflowPanelIds.flatMap(id => {
    const panel = panels.find(panel => panel.id === id);
    return panel ? [panel] : [];
  });
  const empty = overflowPanels.length === 0;
  useLayoutEffect(() => {
    if (empty) setOpened(false);
  }, [empty]);
  return (
    <div aria-hidden={empty || undefined} className="kodex-workspace-tab-overflow" data-empty={empty || undefined} ref={rootRef}>
      <Menu opened={opened && !empty} onChange={setOpened} position="bottom-start" withinPortal>
        <Menu.Target>
          <button ref={buttonRef} aria-label="More tabs" className="kodex-workspace-tab-overflow-button" disabled={empty} type="button">
            +<AnimatedNumber value={overflowPanels.length} />
          </button>
        </Menu.Target>
        <Menu.Dropdown aria-label="More tabs" className="kodex-workspace-tab-overflow-menu">
          {overflowPanels.map(panel => (
            <Menu.Item className="kodex-workspace-tab-overflow-item" data-pane-id={panel.id} key={panel.id} onClick={() => panel.focus()}>
              {panel.title ?? panel.id}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
