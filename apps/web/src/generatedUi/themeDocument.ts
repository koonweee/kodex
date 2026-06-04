import {
  getKodexColorSchemeDefinition,
  type KodexColorSchemeId,
} from "../themeRegistry";

export const GENERATED_UI_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; navigate-to 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

const GENERATED_UI_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const GENERATED_UI_SHARED_VARIABLES: Record<string, string> = {
  "--kodex-bg-panel": "var(--kodex-bg-thread-surface)",
  "--kodex-bg-raised": "var(--kodex-bg-composer)",
  "--kodex-bg-raised-muted": "var(--kodex-bg-composer-muted)",
  "--kodex-bg-raised-alt": "var(--kodex-bg-composer-alt)",
  "--kodex-font-family": GENERATED_UI_FONT_FAMILY,
  "--kodex-font-size-xs": "12px",
  "--kodex-font-size-sm": "13px",
  "--kodex-font-size-md": "14px",
  "--kodex-font-size-lg": "16px",
  "--kodex-radius-xs": "4px",
  "--kodex-radius-sm": "6px",
  "--kodex-radius-md": "8px",
  "--kodex-radius-lg": "10px",
  "--kodex-radius-xl": "16px",
  "--kodex-radius-round": "999px",
  "--kodex-focus-outline": "2px solid var(--kodex-border-accent-soft)",
  "--kodex-focus-offset": "2px",
};

export function buildGeneratedUiThemeCss(colorSchemeId: KodexColorSchemeId): string {
  const colorScheme = getKodexColorSchemeDefinition(colorSchemeId);
  const declarations = {
    "--kodex-color-mode": colorScheme.mode,
    ...colorScheme.rootVariables,
    ...GENERATED_UI_SHARED_VARIABLES,
  };
  const cssVariables = Object.entries(declarations)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

  return `:root {\n  color-scheme: ${colorScheme.mode};\n${cssVariables}\n}\n\nbody {\n  font-family: var(--kodex-font-family);\n}`;
}

export function buildGeneratedUiSrcDoc(html: string, colorSchemeId: KodexColorSchemeId): string {
  const headInjection = generatedUiHeadInjection(colorSchemeId);
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}\n${headInjection}${html.slice(insertAt)}`;
  }

  const htmlMatch = html.match(/<html\b[^>]*>/i);
  if (htmlMatch?.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, insertAt)}\n<head>\n${headInjection}\n</head>${html.slice(insertAt)}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
${headInjection}
</head>
<body>
${html}
</body>
</html>`;
}

function generatedUiHeadInjection(colorSchemeId: KodexColorSchemeId): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(GENERATED_UI_DOCUMENT_CSP)}">
<meta name="color-scheme" content="dark light">
<style id="kodex-generated-ui-theme">
${buildGeneratedUiThemeCss(colorSchemeId)}
</style>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
