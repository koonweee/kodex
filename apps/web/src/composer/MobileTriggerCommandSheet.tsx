import { Box } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";

import type { TriggerSuggestionItem } from "./TriggerSuggestionPopup";

type MobileTriggerCommandSheetProps<TItem extends TriggerSuggestionItem> = {
  activeIndex: number;
  ariaLabel: string;
  emptyLabel: string;
  error?: string | null;
  itemClassName?: string;
  itemIndexAttribute?: string;
  items: TItem[];
  loading?: boolean;
  loadingLabel?: string;
  onSelect: (item: TItem) => void;
  renderItem: (item: TItem, index: number) => ReactNode;
  rootClassName?: string;
  statusClassName?: string;
  statusRootClassName?: string;
};

export function MobileTriggerCommandSheet<TItem extends TriggerSuggestionItem>({
  activeIndex,
  ariaLabel,
  emptyLabel,
  error = null,
  itemClassName = "kodex-mobile-skill-command-row",
  itemIndexAttribute = "data-trigger-option-index",
  items,
  loading = false,
  loadingLabel = "Loading...",
  onSelect,
  renderItem,
  rootClassName = "kodex-mobile-skill-command-list",
  statusClassName = "kodex-mobile-skill-command-status",
  statusRootClassName = "kodex-mobile-skill-command-list kodex-mobile-skill-command-status-list",
}: MobileTriggerCommandSheetProps<TItem>) {
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const option = scrollArea?.querySelector<HTMLElement>(`[${itemIndexAttribute}="${activeIndex}"]`);
    if (!scrollArea || !option) {
      return;
    }

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = scrollArea.scrollTop;
    const visibleBottom = visibleTop + scrollArea.clientHeight;
    if (optionTop < visibleTop) {
      scrollArea.scrollTop = optionTop;
    } else if (optionBottom > visibleBottom) {
      scrollArea.scrollTop = optionBottom - scrollArea.clientHeight;
    }
  }, [activeIndex, itemIndexAttribute]);

  if (loading || error || items.length === 0) {
    return (
      <Box className={statusRootClassName} onPointerDownCapture={(event) => event.stopPropagation()}>
        {loading ? <Box className={statusClassName}>{loadingLabel}</Box> : null}
        {!loading && error ? <Box className={statusClassName}>{error}</Box> : null}
        {!loading && !error && items.length === 0 ? <Box className={statusClassName}>{emptyLabel}</Box> : null}
      </Box>
    );
  }

  return (
    <Box
      ref={scrollAreaRef}
      aria-label={ariaLabel}
      className={rootClassName}
      role="listbox"
      onPointerDownCapture={(event) => event.stopPropagation()}
    >
      {items.map((item, index) => (
        <Box
          component="button"
          key={item.id}
          aria-disabled={item.disabled || undefined}
          aria-selected={index === activeIndex}
          className={itemClassName}
          {...{ [itemIndexAttribute]: index }}
          role="option"
          type="button"
          onClick={() => {
            if (!item.disabled) {
              onSelect(item);
            }
          }}
        >
          {renderItem(item, index)}
        </Box>
      ))}
    </Box>
  );
}
