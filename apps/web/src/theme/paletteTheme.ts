import type { KodexColorSchemeDefinition } from "../themeRegistry";
import type { KodexPalette } from "./tokenContract";

export type PaletteThemeSeed<Id extends string = string> = {
  id: Id;
  label: string;
  description: string;
  mode: "light" | "dark";
  canvas: string;
  shell: string;
  panel: string;
  raised: string;
  ink: string;
  muted: string;
  accent: string;
  danger: string;
  warning: string;
  success: string;
  info: string;
  highContrast?: boolean;
};

function channels(hex: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function mix(from: string, to: string, amount: number) {
  const end = channels(to);
  return `#${channels(from).map((value, index) => Math.round(value + (end[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string) {
  const linear = channels(hex).map((value) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Adapt editor palette ink toward its light/dark endpoint, retaining the hue.
 * This is an authoring baseline; acceptance still requires the rendered gate.
 */
function readable(seed: string, surfaces: string[], endpoint: string, minimum: number) {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(seed, endpoint, step / 100);
    if (surfaces.every((surface) => contrast(candidate, surface) >= minimum)) return candidate;
  }
  throw new Error(`Palette cannot reach ${minimum}:1 against its supported surfaces`);
}

function neutralRamp(light: string, dark: string): KodexPalette {
  return [light, mix(light, dark, 0.1), mix(light, dark, 0.2), mix(light, dark, 0.3), mix(light, dark, 0.4), mix(light, dark, 0.5), mix(light, dark, 0.6), mix(light, dark, 0.7), mix(light, dark, 0.85), dark];
}

function ramp(color: string): KodexPalette {
  return [mix("#ffffff", color, 0.08), mix("#ffffff", color, 0.18), mix("#ffffff", color, 0.32), mix("#ffffff", color, 0.48), mix("#ffffff", color, 0.67), mix("#ffffff", color, 0.85), color, mix(color, "#000000", 0.15), mix(color, "#000000", 0.3), mix(color, "#000000", 0.48)];
}

/** Map independently sourced palette foundations to the shared app contract.
 * No feature-specific colors or new roles are introduced by these adaptations.
 */
export function createPaletteTheme<Id extends string>(seed: PaletteThemeSeed<Id>): Omit<KodexColorSchemeDefinition, "id"> & { id: Id } {
  const dark = seed.mode === "dark";
  const endpoint = dark ? "#ffffff" : "#000000";
  const hover = mix(seed.raised, seed.ink, 0.045);
  const selected = mix(seed.panel, seed.accent, dark ? 0.16 : 0.09);
  const selectedStrong = mix(seed.panel, seed.accent, dark ? 0.23 : 0.14);
  const raisedMuted = mix(seed.raised, seed.ink, 0.025);
  const surfaces = [seed.canvas, seed.shell, seed.panel, seed.raised, raisedMuted, hover, selected, selectedStrong];
  const textMinimum = seed.highContrast ? 7.1 : 5.2;
  const primary = readable(seed.ink, surfaces, endpoint, textMinimum);
  const secondary = readable(mix(seed.ink, seed.panel, 0.12), surfaces, endpoint, textMinimum);
  const muted = readable(seed.muted, surfaces, endpoint, textMinimum);
  const accentText = readable(seed.accent, surfaces, endpoint, textMinimum);
  const border = readable(mix(seed.muted, seed.panel, 0.2), surfaces, endpoint, 3.25);
  // Solid actions choose a separate foreground from bubbles, as required by the contract.
  const actionInk = dark ? seed.canvas : "#ffffff";
  const action = readable(seed.accent, [actionInk], endpoint, seed.highContrast ? 7.1 : 5.5);
  const actionHover = mix(action, dark ? "#ffffff" : "#000000", 0.12);
  const bubbleInk = "#ffffff";
  const bubble = readable(mix(seed.accent, seed.shell, dark ? 0.32 : 0), [bubbleInk], "#000000", 5.5);
  const quiet = (color: string) => mix(seed.panel, color, 0.085);
  const dangerBg = quiet(seed.danger);
  const warningBg = quiet(seed.warning);
  const successBg = quiet(seed.success);
  const infoBg = quiet(seed.info);
  const status = (color: string, background: string) => readable(color, [...surfaces, background], endpoint, textMinimum);
  const dangerText = status(seed.danger, dangerBg);
  const warningText = status(seed.warning, warningBg);
  const successText = status(seed.success, successBg);
  const infoText = status(seed.info, infoBg);
  return {
    id: seed.id,
    label: seed.label,
    description: seed.description,
    mode: seed.mode,
    swatches: [seed.shell, seed.panel, seed.accent],
    rootVariables: {
      "--kodex-bg-action": action,
      "--kodex-bg-action-hover": actionHover,
      "--kodex-text-on-action": actionInk,
      "--kodex-text-on-user-bubble": bubbleInk,
      "--kodex-border-control": border,
      "--kodex-focus-ring": border,
      "--kodex-bg-app": seed.canvas,
      "--kodex-bg-shell": seed.shell,
      "--kodex-bg-thread-surface": seed.panel,
      "--kodex-bg-sidebar-hover": hover,
      "--kodex-bg-composer": seed.raised,
      "--kodex-bg-composer-alt": mix(seed.raised, seed.panel, 0.5),
      "--kodex-bg-composer-muted": raisedMuted,
      "--kodex-bg-button-hover": hover,
      "--kodex-bg-selected": selected,
      "--kodex-bg-selected-strong": selectedStrong,
      "--kodex-bg-command": seed.raised,
      "--kodex-bg-code": mix(seed.panel, seed.accent, 0.055),
      "--kodex-bg-empty-icon": raisedMuted,
      "--kodex-bg-mobile": seed.shell,
      "--kodex-bg-user-bubble": bubble,
      "--kodex-border-subtle": mix(seed.panel, seed.ink, 0.16),
      "--kodex-border-strong": mix(seed.panel, seed.ink, 0.25),
      "--kodex-border-accent": seed.accent,
      "--kodex-border-accent-soft": mix(seed.panel, seed.accent, 0.35),
      "--kodex-text-primary": primary,
      "--kodex-text-secondary": secondary,
      "--kodex-text-muted": muted,
      "--kodex-text-accent": accentText,
      "--kodex-text-accent-soft": accentText,
      "--kodex-text-on-accent": bubbleInk,
      "--kodex-accent": seed.accent,
      "--kodex-accent-strong": accentText,
      "--kodex-accent-muted": muted,
      "--kodex-danger": seed.danger,
      "--kodex-danger-muted": dangerText,
      "--kodex-success": seed.success,
      "--kodex-success-muted": successText,
      "--kodex-warning": seed.warning,
      "--kodex-warning-muted": warningText,
      "--kodex-info": seed.info,
      "--kodex-info-muted": infoText,
      "--kodex-bg-danger": dangerBg,
      "--kodex-border-danger": mix(seed.panel, seed.danger, 0.4),
      "--kodex-text-danger": dangerText,
      "--kodex-bg-warning": warningBg,
      "--kodex-border-warning": mix(seed.panel, seed.warning, 0.4),
      "--kodex-text-warning": warningText,
      "--kodex-bg-info": infoBg,
      "--kodex-border-info": mix(seed.panel, seed.info, 0.4),
      "--kodex-text-info": infoText,
      "--kodex-bg-success": successBg,
      "--kodex-border-success": mix(seed.panel, seed.success, 0.4),
      "--kodex-text-success": successText,
      "--kodex-shadow-strong": `0 16px 48px rgb(0 0 0 / ${dark ? "34%" : "12%"})`,
      "--kodex-shadow-floating": `0 6px 18px rgb(0 0 0 / ${dark ? "28%" : "10%"})`,
      "--kodex-overlay-strong": `rgb(0 0 0 / ${dark ? "70%" : "20%"})`,
      "--kodex-overlay-muted": `rgb(0 0 0 / ${dark ? "58%" : "14%"})`,
      "--kodex-inline-code-border": mix(seed.panel, seed.accent, 0.3),
      "--kodex-scroll-button-bg": seed.raised,
      "--kodex-scroll-button-hover": hover,
      "--kodex-scroll-button-color": primary,
      "--kodex-scroll-button-border": border,
      "--kodex-context-unused": mix(seed.panel, seed.ink, 0.3),
      "--kodex-context-unknown": mix(seed.panel, seed.ink, 0.5),
      "--kodex-context-unknown-muted": mix(seed.panel, seed.ink, 0.2),
    },
    mantineAccent: ramp(seed.accent),
    mantineGray: neutralRamp(dark ? seed.ink : seed.panel, dark ? seed.panel : seed.ink),
    mantineRed: ramp(seed.danger),
  };
}
