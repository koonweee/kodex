import { ActionIcon, Tooltip, type ActionIconProps, type TooltipProps } from "@mantine/core";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { AdaptiveIcon } from "./AdaptiveIcon";

type AdaptiveIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "color"> & {
  children: ReactNode;
  color?: ActionIconProps["color"];
  density?: "compact" | "standard";
  label: string;
  loading?: ActionIconProps["loading"];
  shape?: "default" | "round";
  tooltip?: ReactNode | false;
  tooltipProps?: Omit<TooltipProps, "children" | "label">;
  variant?: ActionIconProps["variant"];
};

export function AdaptiveIconButton({
  children,
  className,
  density = "standard",
  label,
  shape = "default",
  type = "button",
  tooltip,
  tooltipProps,
  variant = "subtle",
  ...props
}: AdaptiveIconButtonProps) {
  const button = (
    <ActionIcon
      aria-label={label}
      className={["kodex-adaptive-icon-button", className].filter(Boolean).join(" ")}
      data-density={density}
      radius={shape === "round" ? "xl" : undefined}
      size={32}
      type={type}
      variant={variant}
      {...props}
    >
      <AdaptiveIcon color="inherit" density={density}>
        {children}
      </AdaptiveIcon>
    </ActionIcon>
  );

  if (tooltip === false) {
    return button;
  }

  return (
    <Tooltip label={tooltip ?? label} {...tooltipProps}>
      {button}
    </Tooltip>
  );
}
