import {
  getKodexColorSchemeDefinition,
  type KodexColorSchemeId,
} from "../themeRegistry";

export type GeneratedUiDocumentCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
};

export const GENERATED_UI_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

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

export function buildGeneratedUiSrcDoc(
  html: string,
  colorSchemeId: KodexColorSchemeId,
  csp?: GeneratedUiDocumentCsp,
): string {
  const headInjection = generatedUiHeadInjection(colorSchemeId, csp);
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

function generatedUiHeadInjection(colorSchemeId: KodexColorSchemeId, csp?: GeneratedUiDocumentCsp): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(buildGeneratedUiDocumentCsp(csp))}">
<meta name="color-scheme" content="dark light">
<script id="kodex-generated-ui-bridge">
${GENERATED_UI_BRIDGE_SCRIPT}
</script>
<style id="kodex-generated-ui-theme">
${buildGeneratedUiThemeCss(colorSchemeId)}
</style>`;
}

const GENERATED_UI_BRIDGE_SCRIPT = `(() => {
  const submitType = "kodex.generatedUi.submit";
  const submitResultType = "kodex.generatedUi.submit.result";
  const pending = new Map();

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.type !== submitResultType || typeof data.requestId !== "string") {
      return;
    }
    const request = pending.get(data.requestId);
    if (!request) {
      return;
    }
    window.clearTimeout(request.timeout);
    pending.delete(data.requestId);
    if (data.ok) {
      request.resolve(data);
    } else {
      const error = new Error(data.error?.message || "Generated UI submit was not accepted.");
      error.details = data;
      request.reject(error);
    }
  });

  function submitMessage(message, metadata) {
    const requestId = "kodex-submit-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const payload = { type: submitType, requestId, message, metadata };
    const response = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Timed out waiting for Kodex to acknowledge generated UI submit."));
      }, 30000);
      pending.set(requestId, { resolve, reject, timeout });
    });
    window.parent.postMessage(payload, "*");
    return response;
  }

  window.kodex = Object.assign({}, window.kodex, {
    submitMessage,
    bridge: Object.assign({}, window.kodex?.bridge, {
      submitEventType: submitType,
      submitResultEventType: submitResultType,
    }),
  });
})();`;

export function buildGeneratedUiDocumentCsp(csp?: GeneratedUiDocumentCsp): string {
  const connectDomains = cleanSources(csp?.connectDomains);
  const resourceDomains = cleanSources(csp?.resourceDomains);
  if (connectDomains.length === 0 && resourceDomains.length === 0) {
    return GENERATED_UI_DOCUMENT_CSP;
  }
  const connectSrc = sourceList(connectDomains);
  const resourceSrc = sourceList(resourceDomains);
  const imageSrc = resourceSrc === "'none'" ? "data: blob:" : `data: blob: ${resourceSrc}`;
  const fontSrc = resourceSrc === "'none'" ? "data:" : `data: ${resourceSrc}`;
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src ${imageSrc}`,
    `media-src ${resourceSrc}`,
    `font-src ${fontSrc}`,
    `connect-src ${connectSrc}`,
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function cleanSources(sources: string[] | undefined): string[] {
  return (sources ?? []).filter((source) => typeof source === "string" && source.trim()).map((source) => source.trim());
}

function sourceList(sources: string[]): string {
  return sources.length > 0 ? sources.join(" ") : "'none'";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
