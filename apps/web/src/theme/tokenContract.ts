/**
 * Complete per-theme contract. Shared aliases (bg-panel, bg-raised, bg-sidebar and
 * disabled states) are derived centrally in styles/ui.css. Read
 * docs/theme-guidelines.md before adding a theme or choosing surface roles.
 * Feature CSS must not invent tokens or depend on a theme's palette indexes.
 */
export type KodexThemeTokens = {
  /** Solid action fills; both must contrast >=4.5:1 with text-on-action. */
  "--kodex-bg-action": string;
  "--kodex-bg-action-hover": string;
  /** Foreground for solid actions and selected control marks; separate from bubble ink. */
  "--kodex-text-on-action": string;
  /** Body foreground on bg-user-bubble; >=4.5:1. */
  "--kodex-text-on-user-bubble": string;
  /** Essential control edge and keyboard focus; opaque, >=3:1 against adjacent neutral fills. */
  "--kodex-border-control": string;
  "--kodex-focus-ring": string;
  /** App canvas and shell/sidebar surfaces. Pair with neutral text. */
  "--kodex-bg-app": string;
  "--kodex-bg-shell": string;
  /** Main content/dialogs; exposed as bg-panel. */
  "--kodex-bg-thread-surface": string;
  "--kodex-bg-sidebar-hover": string;
  /** Raised/floating controls; exposed as bg-raised, bg-raised-alt, bg-raised-muted. */
  "--kodex-bg-composer": string;
  "--kodex-bg-composer-alt": string;
  "--kodex-bg-composer-muted": string;
  /** Neutral hover and selection fills; prefer primary/secondary ink. */
  "--kodex-bg-button-hover": string;
  "--kodex-bg-selected": string;
  "--kodex-bg-selected-strong": string;
  /** Output/code surfaces; syntax colors and links need their own rendered validation. */
  "--kodex-bg-command": string;
  "--kodex-bg-code": string;
  "--kodex-bg-empty-icon": string;
  "--kodex-bg-mobile": string;
  /** User messages pair only with text-on-user-bubble. */
  "--kodex-bg-user-bubble": string;
  /** Decorative separators/outlines. Essential boundaries and focus use dedicated roles. */
  "--kodex-border-subtle": string;
  "--kodex-border-strong": string;
  "--kodex-border-accent": string;
  "--kodex-border-accent-soft": string;
  /** Body/headings and supporting labels; >=4.5:1 on supported neutral surfaces. */
  "--kodex-text-primary": string;
  "--kodex-text-secondary": string;
  /** Quiet readable metadata/placeholders; >=4.5:1 on neutral/hover/selected fills. No opacity. */
  "--kodex-text-muted": string;
  /** Readable links/accent labels on neutral/selected fills; never use raw accent as body ink. */
  "--kodex-text-accent": string;
  "--kodex-text-accent-soft": string;
  /** Legacy foreground; new actions and bubbles use their dedicated pairs. */
  "--kodex-text-on-accent": string;
  /** Decorative brand accents. Not implicit text or solid-action pairs. */
  "--kodex-accent": string;
  "--kodex-accent-strong": string;
  "--kodex-accent-muted": string;
  /** Decorative status colors; readable status content uses the matching text-{tone}. */
  "--kodex-danger": string;
  "--kodex-danger-muted": string;
  "--kodex-success": string;
  "--kodex-success-muted": string;
  "--kodex-warning": string;
  "--kodex-warning-muted": string;
  "--kodex-info": string;
  "--kodex-info-muted": string;
  /** Keep matching status fill/border/foreground triplets together. Text must be >=4.5:1. */
  "--kodex-bg-danger": string;
  "--kodex-border-danger": string;
  "--kodex-text-danger": string;
  "--kodex-bg-warning": string;
  "--kodex-border-warning": string;
  "--kodex-text-warning": string;
  "--kodex-bg-info": string;
  "--kodex-border-info": string;
  "--kodex-text-info": string;
  "--kodex-bg-success": string;
  "--kodex-border-success": string;
  "--kodex-text-success": string;
  /** Elevation decoration and scrims. Shadows do not replace essential control boundaries. */
  "--kodex-shadow-strong": string;
  "--kodex-shadow-floating": string;
  "--kodex-overlay-strong": string;
  "--kodex-overlay-muted": string;
  "--kodex-inline-code-border": string;
  /** Scroll-to-latest control; icon must contrast >=3:1 with both fills. */
  "--kodex-scroll-button-bg": string;
  "--kodex-scroll-button-hover": string;
  "--kodex-scroll-button-color": string;
  "--kodex-scroll-button-border": string;
  /** Context-meter graphic segments; never use as readable text. */
  "--kodex-context-unused": string;
  "--kodex-context-unknown": string;
  "--kodex-context-unknown-muted": string;
};

/** Exactly ten colors per Mantine ramp. Feature UI consumes semantic roles instead. */
export type KodexPalette = [string, string, string, string, string, string, string, string, string, string];
