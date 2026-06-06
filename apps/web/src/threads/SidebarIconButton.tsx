import type { ComponentProps } from "react";

import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";

type SidebarIconButtonProps = Omit<ComponentProps<typeof AdaptiveIconButton>, "className"> & {
  className?: string;
};

export function SidebarIconButton({
  className,
  color,
  tooltipProps,
  ...props
}: SidebarIconButtonProps) {
  return (
    <AdaptiveIconButton
      className={["kodex-sidebar-icon-button", className].filter(Boolean).join(" ")}
      color={color}
      tooltipProps={{ position: "right", ...tooltipProps }}
      {...props}
    />
  );
}
