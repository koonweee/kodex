import { Box } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";

export type TriggerSuggestionItem = {
  disabled?: boolean;
  id: string;
};

type TriggerSuggestionPopupProps<TItem extends TriggerSuggestionItem> = {
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
  scrollClassName?: string;
  statusClassName?: string;
};

export function TriggerSuggestionPopup<TItem extends TriggerSuggestionItem>({
  activeIndex,
  ariaLabel,
  emptyLabel,
  error = null,
  itemClassName = "kodex-skill-popup-row",
  itemIndexAttribute = "data-trigger-option-index",
  items,
  loading = false,
  loadingLabel = "Loading...",
  onSelect,
  renderItem,
  rootClassName = "kodex-skill-popup",
  scrollClassName = "kodex-skill-popup-scroll",
  statusClassName = "kodex-skill-popup-status",
}: TriggerSuggestionPopupProps<TItem>) {
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

  return (
    <Box className={rootClassName}>
      <Box ref={scrollAreaRef} className={scrollClassName} role="listbox" aria-label={ariaLabel}>
        {loading ? <Box className={statusClassName}>{loadingLabel}</Box> : null}
        {!loading && error ? <Box className={statusClassName}>{error}</Box> : null}
        {!loading && !error && items.length === 0 ? <Box className={statusClassName}>{emptyLabel}</Box> : null}
        {!loading && !error
          ? items.map((item, index) => (
              <Box
                key={item.id}
                aria-disabled={item.disabled || undefined}
                aria-selected={index === activeIndex}
                className={itemClassName}
                {...{ [itemIndexAttribute]: index }}
                role="option"
                onClick={() => {
                  if (!item.disabled) {
                    onSelect(item);
                  }
                }}
              >
                {renderItem(item, index)}
              </Box>
            ))
          : null}
      </Box>
    </Box>
  );
}
