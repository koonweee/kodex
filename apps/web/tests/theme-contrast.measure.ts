// Chromium diagnostics for flat CSS colors, not a complete WCAG conformance test.
export function measureTheme() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  function rgba(css: string): number[] {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
    const c = [...ctx.getImageData(0, 0, 1, 1).data];
    return [c[0], c[1], c[2], c[3] / 255];
  }
  function over(fg: number[], bg: number[]): number[] {
    return [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  }
  function background(el: Element | null): number[] {
    if (!el) return [255, 255, 255, 1];
    const c = rgba(getComputedStyle(el).backgroundColor);
    return c[3] === 1 ? c : over(c, background(el.parentElement));
  }
  function ratio(a: number[], b: number[]) {
    const lum = (c: number[]) => c.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
    const [l, r] = [lum(a), lum(b)];
    return (Math.max(l, r) + .05) / (Math.min(l, r) + .05);
  }
  // Dialog backdrops visually occlude the app; do not report the dimmed app as active UI.
  const activeDialog = [...document.querySelectorAll('.kodex-mantine-modal-content,.kodex-mantine-drawer-content')]
    .find(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const scope = activeDialog ?? document;
  const samples = [...scope.querySelectorAll("button,input,textarea,label,p,a,th,td,h1,h2,h3,code,[role=tab],[role=menuitem],[role=option],[role=tooltip],.mantine-Progress-label,.kodex-mantine-alert-message,.kodex-mantine-alert-title,.kodex-mantine-badge-root,.kodex-user-message")].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }).map(el => {
    const css = getComputedStyle(el), bg = background(el), ancestors = [];
    for (let parent: Element | null = el; parent; parent = parent.parentElement) ancestors.push(parent);
    const unsupported = ancestors.some(parent => Number(getComputedStyle(parent).opacity) < 1 || getComputedStyle(parent).backgroundImage !== "none");
    return {
      label: (el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || "").trim().slice(0, 100),
      tag: el.tagName, class: el.className, foreground: css.color, background: bg.slice(0, 3),
      ratio: ratio(over(rgba(css.color), bg), bg),
      placeholderRatio: el.matches("input,textarea") ? ratio(over(rgba(getComputedStyle(el, "::placeholder").color), bg), bg) : null,
      // Outer edge only; applicability (essential control vs decoration) needs review.
      borderRatio: parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none" && rgba(css.borderTopColor)[3] > 0
        ? ratio(over(rgba(css.borderTopColor), background(el.parentElement)), background(el.parentElement)) : null,
      outline: css.outline, disabled: el.matches(":disabled,[data-disabled],[aria-disabled=true]"),
      unsupported, fontSize: css.fontSize, fontWeight: css.fontWeight,
    };
  });
  const probe = document.createElement("span"); document.body.append(probe);
  function token(name: string) { probe.style.color = `var(--kodex-${name})`; return rgba(getComputedStyle(probe).color); }
  const pairs = [
    ["text-primary", "bg-panel"], ["text-secondary", "bg-panel"], ["text-muted", "bg-panel"],
    ["text-muted", "bg-selected-strong"], ["text-muted", "bg-button-hover"], ["text-accent", "bg-panel"],
    ["text-on-accent", "accent"], ["text-on-accent", "bg-user-bubble"],
    ["border-subtle", "bg-raised-muted"], ["border-accent-soft", "bg-panel"],
    ...["danger", "warning", "success", "info"].map(tone => [`text-${tone}`, `bg-${tone}`]),
  ].map(([foreground, bg]) => {
    const back = token(bg), front = over(token(foreground), back);
    return { foreground, background: bg, ratio: ratio(front, back), fg: front, bg: back };
  });
  probe.remove(); return { samples, pairs };
}
