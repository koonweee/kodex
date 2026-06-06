import { ActionIcon, Tooltip, type ActionIconProps, type TooltipProps } from "@mantine/core";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { AdaptiveIcon } from "./AdaptiveIcon";

type AdaptiveIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "color"> & {
  children: ReactNode;
  color?: ActionIconProps["color"];
  density?: "compact" | "standard";
  iconColor?: "default" | "inherit";
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
  color,
  density = "standard",
  iconColor,
  label,
  shape = "default",
  type = "button",
  tooltip,
  tooltipProps,
  variant = "subtle",
  ...props
}: AdaptiveIconButtonProps) {
  const resolvedIconColor = iconColor ?? (color || variant === "filled" ? "inherit" : "default");

  const button = (
    <ActionIcon
      aria-label={label}
      className={["kodex-adaptive-icon-button", className].filter(Boolean).join(" ")}
      color={color}
      data-density={density}
      radius={shape === "round" ? "xl" : undefined}
      size={32}
      type={type}
      variant={variant}
      {...props}
    >
      <AdaptiveIcon color={resolvedIconColor} density={density}>
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
