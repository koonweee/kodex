import { defaultVariantColorsResolver, type VariantColorsResolver } from "@mantine/core";

import type { KodexThemeTokens } from "./tokenContract";

type RegistryTokenName = keyof KodexThemeTokens extends `--kodex-${infer Name}` ? Name : never;
const token = (name: RegistryTokenName | "bg-panel" | "bg-raised" | "bg-raised-muted") => `var(--kodex-${name})`;
const tones: Record<string, "danger" | "warning" | "success" | "info"> = { red: "danger", yellow: "warning", orange: "warning", green: "success", blue: "info" };

/** Supported product colors resolve to semantic pairs, never a palette index. */
export function semanticColors(color = "accent") {
  if (color === "accent") return {
    background: token("bg-selected"), hover: token("bg-selected-strong"), text: token("text-accent"),
    border: token("border-accent-soft"), solid: token("bg-action"), solidHover: token("bg-action-hover"), onSolid: token("text-on-action"),
  };
  if (color === "gray") return {
    background: token("bg-raised-muted"), hover: token("bg-button-hover"), text: token("text-secondary"),
    border: token("border-subtle"), solid: token("text-secondary"), solidHover: token("text-primary"), onSolid: token("bg-panel"),
  };
  const tone = tones[color];
  if (!tone) return null; // Explicit brand/custom colors retain Mantine semantics and need their own audit.
  return {
    background: token(`bg-${tone}`), hover: token(`bg-${tone}`), text: token(`text-${tone}`),
    border: token(`border-${tone}`), solid: token(`text-${tone}`), solidHover: token(`text-${tone}`), onSolid: token(`bg-${tone}`),
  };
}

export const kodexVariantColorResolver: VariantColorsResolver = (input) => {
  const colors = semanticColors(input.color ?? input.theme.primaryColor);
  if (!colors || !["filled", "light", "outline", "subtle", "transparent", "default", "white"].includes(input.variant)) {
    return defaultVariantColorsResolver(input);
  }
  const border = "1px solid transparent";
  switch (input.variant) {
    case "filled": return { background: colors.solid, hover: colors.solidHover, color: colors.onSolid, border };
    case "light": return { background: colors.background, hover: colors.hover, color: colors.text, border: `1px solid ${colors.border}` };
    case "outline": return { background: "transparent", hover: colors.background, color: colors.text, border: `1px solid ${colors.text}` };
    case "subtle": return { background: "transparent", hover: colors.background, color: colors.text, border };
    case "transparent": return { background: "transparent", hover: "transparent", color: colors.text, border };
    default: return { background: token("bg-raised"), hover: token("bg-button-hover"), color: token("text-primary"), border: `1px solid ${token("border-control")}` };
  }
};
