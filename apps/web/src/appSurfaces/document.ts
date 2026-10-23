import {
  getKodexColorSchemeDefinition,
  type KodexColorSchemeId,
} from "../themeRegistry";
import type { AppSurfaceSession } from "../api/client";

type AppSurfaceDocumentCsp = NonNullable<AppSurfaceSession["csp"]> & {
  baseUriDomains?: string[];
  frameDomains?: string[];
};

const APP_SURFACE_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const APP_SURFACE_SHARED_VARIABLES: Record<string, string> = {
  "--kodex-bg-panel": "var(--kodex-bg-thread-surface)",
  "--kodex-pane-bg": "var(--kodex-bg-panel)",
  "--kodex-app-surface-bg": "var(--kodex-bg-panel)",
  "--kodex-bg-raised": "var(--kodex-bg-composer)",
  "--kodex-bg-raised-muted": "var(--kodex-bg-composer-muted)",
  "--kodex-bg-raised-alt": "var(--kodex-bg-composer-alt)",
  "--kodex-font-family": APP_SURFACE_FONT_FAMILY,
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

export function buildAppSurfaceResourceHtml(
  html: string,
  colorSchemeId: KodexColorSchemeId,
  csp?: AppSurfaceDocumentCsp,
  presentation: "pane" | "inline" = "pane",
): string {
  const headBootstrap = appSurfaceHeadBootstrap(csp) + (presentation === "inline" ? INLINE_FOCUS_GUARD : "");
  const themeInjection = appSurfaceThemeInjection(colorSchemeId) + (presentation === "inline" ? inlineDocumentInjection() : "");
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const bootstrapAt = headMatch.index + headMatch[0].length;
    const withBootstrap = `${html.slice(0, bootstrapAt)}\n${headBootstrap}${html.slice(bootstrapAt)}`;
    const headCloseMatch = withBootstrap.match(/<\/head\s*>/i);
    if (headCloseMatch?.index !== undefined) {
      return `${withBootstrap.slice(0, headCloseMatch.index)}\n${themeInjection}\n${withBootstrap.slice(headCloseMatch.index)}`;
    }
    return `${withBootstrap}\n${themeInjection}`;
  }

  const htmlMatch = html.match(/<html\b[^>]*>/i);
  if (htmlMatch?.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${html.slice(0, insertAt)}\n<head>\n${headBootstrap}\n${themeInjection}\n</head>${html.slice(insertAt)}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
${headBootstrap}
${themeInjection}
</head>
<body>
${html}
</body>
</html>`;
}

export function buildAppSurfaceThemeCss(colorSchemeId: KodexColorSchemeId): string {
  const colorScheme = getKodexColorSchemeDefinition(colorSchemeId);
  const declarations = {
    "--kodex-color-mode": colorScheme.mode,
    ...colorScheme.rootVariables,
    ...APP_SURFACE_SHARED_VARIABLES,
  };
  const cssVariables = Object.entries(declarations)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

  return `:root {\n  color-scheme: ${colorScheme.mode};\n${cssVariables}\n}\n\nhtml {\n  min-height: 100%;\n  min-height: 100vh;\n  background: var(--kodex-app-surface-bg) !important;\n}\n\nbody {\n  min-height: 100%;\n  min-height: 100vh;\n  margin: 0;\n  background: var(--kodex-app-surface-bg) !important;\n  color: var(--kodex-text-primary);\n  font-family: var(--kodex-font-family);\n}`;
}

export function appSurfaceBackgroundColor(colorSchemeId: KodexColorSchemeId): string {
  const colorScheme = getKodexColorSchemeDefinition(colorSchemeId);
  return colorScheme.rootVariables["--kodex-bg-thread-surface"] ?? colorScheme.rootVariables["--kodex-bg-app"] ?? "#151515";
}

export function buildAppSurfaceDocumentCsp(csp?: AppSurfaceDocumentCsp): string {
  const connectSrc = sourceList(cleanSources(csp?.connectDomains));
  const resourceSrc = sourceList(cleanSources(csp?.resourceDomains), "'self' data:");
  const frameSrc = sourceList(cleanSources(csp?.frameDomains));
  const baseUri = sourceList(cleanSources(csp?.baseUriDomains));
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${resourceSrc}`,
    `style-src 'self' 'unsafe-inline' ${resourceSrc}`,
    `img-src ${resourceSrc}`,
    `media-src ${resourceSrc}`,
    `font-src ${resourceSrc}`,
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-src ${frameSrc}`,
    `base-uri ${baseUri}`,
  ].join("; ");
}

function appSurfaceHeadBootstrap(csp?: AppSurfaceDocumentCsp): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(buildAppSurfaceDocumentCsp(csp))}">
<meta name="color-scheme" content="dark light">
<script id="kodex-app-surface-bridge">
${APP_SURFACE_BRIDGE_SCRIPT}
</script>`;
}

function appSurfaceThemeInjection(colorSchemeId: KodexColorSchemeId): string {
  return `<style id="kodex-app-surface-theme">
${buildAppSurfaceThemeCss(colorSchemeId)}
</style>`;
}

const APP_SURFACE_BRIDGE_SCRIPT = `(() => {
  const pending = new Map();

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0" || data.id === undefined) {
      return;
    }
    const request = pending.get(data.id);
    if (!request) {
      return;
    }
    window.clearTimeout(request.timeout);
    pending.delete(data.id);
    if (data.error) {
      const error = new Error(data.error.message || "App surface bridge request failed.");
      error.details = data.error;
      request.reject(error);
      return;
    }
    request.resolve(data.result ?? {});
  });

  function request(method, params) {
    const id = "kodex-app-surface-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const response = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error("Timed out waiting for Kodex app surface bridge response."));
      }, 30000);
      pending.set(id, { resolve, reject, timeout });
    });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params: params ?? {} }, "*");
    return response;
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method, params: params ?? {} }, "*");
  }

  function submitMessage(text, meta) {
    return request("ui/message", {
      role: "user",
      content: { type: "text", text },
      _meta: meta,
    });
  }

  window.kodex = Object.assign({}, window.kodex, {
    bridge: Object.assign({}, window.kodex?.bridge, { request, notify }),
    submitMessage,
  });
})();`;

function cleanSources(sources: string[] | undefined): string[] {
  return (sources ?? []).filter((source) => typeof source === "string" && source.trim()).map((source) => source.trim());
}

function sourceList(sources: string[], fallback = "'none'"): string {
  return sources.length > 0 ? sources.join(" ") : fallback;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineDocumentInjection(): string {
  return `<style id="kodex-inline-layout">html { min-height: 0; height: auto; overflow: hidden; } body { min-height: 0; height: auto; display: flow-root; overflow: visible; }</style>
<script id="kodex-inline-sizing">(() => {
  let queued = false;
  let previous = 0;
  const measure = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const body = document.body;
      if (!body) return;
      const height = Math.max(1, Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight)));
      if (height === previous) return;
      previous = height;
      window.parent.postMessage({jsonrpc: '2.0',method: 'ui/notifications/size-changed',params: {height}}, '*');
    });
  };
  const start = () => {
    new ResizeObserver(measure).observe(document.body);
    new MutationObserver(measure).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    document.addEventListener('load',measure,true);
    window.addEventListener('resize',measure);
    document.fonts?.ready.then(measure);
    measure();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();</script>`;
}

// Prevent creation/remount scripts and autofocus from taking focus out of the chat.
// Trusted interaction still enables normal application-managed focus thereafter.
const INLINE_FOCUS_GUARD = `<script id="kodex-inline-focus">(() => {
  let interacted = false;
  const activate = event => { if (event.isTrusted) interacted = true; };
  document.addEventListener('pointerdown',activate,true);
  document.addEventListener('click',activate,true);
  document.addEventListener('keydown',activate,true);
  for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
    const focus = prototype.focus;
    if (typeof focus === 'function') prototype.focus = function(...args) { if (interacted) return focus.apply(this,args); };
  }
  const removeAutofocus = () => {
    if (!interacted) document.querySelectorAll('[autofocus]').forEach(element => element.removeAttribute('autofocus'));
  };
  new MutationObserver(removeAutofocus).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['autofocus']});
  removeAutofocus();
})();</script>`;
