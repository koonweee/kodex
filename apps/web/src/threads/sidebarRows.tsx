import { ActionIcon, Box, Text, Tooltip } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import type { DragEvent as ReactDragEvent, HTMLAttributes, ReactNode } from "react";

export type SidebarRowAction = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
};

type DataAttributes = {
  [key: `data-${string}`]: string | undefined;
};

export type SidebarRowFrameProps = {
  children: ReactNode;
  className?: string;
  collapsed?: boolean;
  leadingContent?: ReactNode;
  leadingIcon?: ReactNode;
  reserveLeading?: boolean;
  rootProps?: HTMLAttributes<HTMLDivElement> &
    DataAttributes & {
    draggable?: boolean;
    onDragEnd?: (event: ReactDragEvent<HTMLElement>) => void;
    onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
    onDragStart?: (event: ReactDragEvent<HTMLElement>) => void;
  };
  trailingContent?: ReactNode;
  trailingActions?: SidebarRowAction[];
};

export function SidebarRowFrame({
  children,
  className,
  collapsed,
  leadingContent,
  leadingIcon,
  reserveLeading = false,
  rootProps,
  trailingContent,
  trailingActions = [],
}: SidebarRowFrameProps) {
  const rootClassName = ["kodex-sidebar-row", className, rootProps?.className].filter(Boolean).join(" ");
  const leading = leadingContent ?? leadingIcon;
  const trailingActionNodes = trailingActions.map((action) => (
    <Tooltip key={action.label} label={action.label}>
      <ActionIcon
        aria-label={action.label}
        className="kodex-sidebar-row-action"
        color="gray"
        onClick={action.onClick}
        size="xs"
        variant="subtle"
      >
        {action.icon}
      </ActionIcon>
    </Tooltip>
  ));
  const trailing = trailingContent ?? trailingActionNodes;
  const hasTrailing = Boolean(trailingContent) || trailingActionNodes.length > 0;

  return (
    <Box
      {...rootProps}
      className={rootClassName}
      data-collapsed={collapsed ? "true" : undefined}
      data-has-leading={leading || reserveLeading ? "true" : undefined}
    >
      {leading || reserveLeading ? <span className="kodex-sidebar-row-leading">{leading}</span> : null}
      {children}
      {hasTrailing ? <span className="kodex-sidebar-row-trailing">{trailing}</span> : null}
    </Box>
  );
}

function DisclosureChevron() {
  return <ChevronRight aria-hidden="true" className="kodex-sidebar-row-disclosure" />;
}

export function SidebarSectionDisclosureRow({
  className,
  collapsed,
  label,
  onToggle,
  trailingActions,
}: {
  className?: string;
  collapsed: boolean;
  label: string;
  onToggle: () => void;
  trailingActions?: SidebarRowAction[];
}) {
  return (
    <SidebarRowFrame className={["kodex-sidebar-section-row", className].filter(Boolean).join(" ")} collapsed={collapsed} trailingActions={trailingActions}>
      <button
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label} section`}
        className="kodex-ui-button kodex-sidebar-row-main kodex-sidebar-section-toggle"
        onClick={onToggle}
        type="button"
      >
        <Text component="span" className="kodex-sidebar-row-label" fw={400} size="xs">
          {label}
        </Text>
        <DisclosureChevron />
      </button>
    </SidebarRowFrame>
  );
}

export function SidebarActionDisclosureRow({
  className,
  collapsed,
  disclosureLabel,
  label,
  leadingIcon,
  mainClassName,
  onToggle,
  rootProps,
  trailingActions,
}: {
  className?: string;
  collapsed: boolean;
  disclosureLabel: string;
  label: string;
  leadingIcon?: ReactNode;
  mainClassName?: string;
  onToggle: () => void;
  rootProps?: SidebarRowFrameProps["rootProps"];
  trailingActions?: SidebarRowAction[];
}) {
  return (
    <SidebarRowFrame
      className={className}
      collapsed={collapsed}
      leadingIcon={leadingIcon}
      rootProps={rootProps}
      trailingActions={trailingActions}
    >
      <button
        aria-expanded={!collapsed}
        aria-label={disclosureLabel}
        className={["kodex-ui-button kodex-sidebar-row-main kodex-sidebar-item-toggle", mainClassName].filter(Boolean).join(" ")}
        onClick={onToggle}
        type="button"
      >
        <Text component="span" className="kodex-sidebar-row-label" fw={400} size="xs" lineClamp={1}>
          {label}
        </Text>
        <DisclosureChevron />
      </button>
    </SidebarRowFrame>
  );
}
