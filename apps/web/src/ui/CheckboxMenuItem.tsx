import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

type CheckboxMenuItemProps = {
  checked: boolean;
  children: ReactNode;
  className?: string;
  leftSection?: ReactNode;
  onChange: (checked: boolean) => void;
  rightSection?: ReactNode;
};

export function CheckboxMenuItem({
  checked,
  children,
  className,
  leftSection,
  onChange,
  rightSection,
}: CheckboxMenuItemProps) {
  function handleMouseDown(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onChange(!checked);
      return;
    }

    focusMenuItemByKey(event);
  }

  return (
    <button
      aria-checked={checked}
      className={["kodex-mantine-menu-item", className].filter(Boolean).join(" ")}
      data-active={checked ? "true" : undefined}
      data-mantine-stop-propagation
      data-menu-item
      onClick={() => onChange(!checked)}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      role="menuitemcheckbox"
      tabIndex={-1}
      type="button"
    >
      {leftSection ? (
        <span className="kodex-mantine-menu-item-section" data-position="left">
          {leftSection}
        </span>
      ) : null}
      <span className="kodex-mantine-menu-item-label">{children}</span>
      {rightSection ? (
        <span className="kodex-mantine-menu-item-section" data-position="right">
          {rightSection}
        </span>
      ) : null}
    </button>
  );
}

function focusMenuItemByKey(event: KeyboardEvent<HTMLButtonElement>) {
  const dropdown = event.currentTarget.closest("[data-menu-dropdown]");
  if (!dropdown) {
    return;
  }

  const items = Array.from(dropdown.querySelectorAll<HTMLElement>("[data-menu-item]:not([data-disabled])"));
  const currentIndex = items.indexOf(event.currentTarget);
  if (currentIndex === -1) {
    return;
  }

  let nextIndex: number | null = null;
  if (event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % items.length;
  } else if (event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + items.length) % items.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  }

  if (nextIndex !== null) {
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  }
}
