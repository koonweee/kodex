import type { HTMLAttributes, ReactNode } from "react";

type AdaptiveIconProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  color?: "default" | "inherit";
  density?: "compact" | "standard";
  label?: string;
};

export function AdaptiveIcon({
  children,
  className,
  color = "default",
  density = "standard",
  label,
  ...props
}: AdaptiveIconProps) {
  return (
    <span
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={["kodex-adaptive-icon", className].filter(Boolean).join(" ")}
      data-color={color}
      data-density={density}
      role={label ? "img" : undefined}
      {...props}
    >
      {children}
    </span>
  );
}
