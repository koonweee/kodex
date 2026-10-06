// Chromium diagnostics for flat CSS colors, not a complete WCAG conformance test.
// An optional element limits automatic checks to an explicitly applicable specimen.
// The broad no-argument sample remains diagnostic, because not every border or
// piece of text in a contact sheet has the same accessibility contract.
export function measureTheme(target?: Element) {
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
  const samples = (target ? [target] : [...scope.querySelectorAll("button,button svg,input,textarea,label,p,a,th,td,h1,h2,h3,code,[role=tab],[role=menuitem],[role=option],[role=tooltip],.mantine-Progress-label,.kodex-mantine-alert-message,.kodex-mantine-alert-title,.kodex-mantine-badge-root,.kodex-user-message")]).filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }).map(el => {
    // Mantine paints checked glyphs above a sibling native input. DOM ancestry
    // alone would incorrectly compare the glyph to the panel behind that input.
    const svg = el instanceof SVGElement ? (el instanceof SVGSVGElement ? el : el.ownerSVGElement) : null;
    const control = svg?.parentElement?.querySelector("input:checked");
    const glyphRect = svg?.getBoundingClientRect(), controlRect = control?.getBoundingClientRect();
    const overControl = glyphRect && controlRect && glyphRect.left >= controlRect.left && glyphRect.right <= controlRect.right
      && glyphRect.top >= controlRect.top && glyphRect.bottom <= controlRect.bottom ? control : null;
    const css = getComputedStyle(el), bg = background(overControl ?? el), outer = background(el.parentElement), ancestors = [];
    for (let parent: Element | null = el; parent; parent = parent.parentElement) ancestors.push(parent);
    if (overControl) ancestors.push(overControl);
    const unsupported = ancestors.some(parent => Number(getComputedStyle(parent).opacity) < 1 || getComputedStyle(parent).backgroundImage !== "none");
    const foreground = el instanceof SVGElement ? css.stroke !== "none" ? css.stroke : css.fill !== "none" ? css.fill : css.color : css.color;
    const placeholder = getComputedStyle(el, "::placeholder");
    const placeholderColor = rgba(placeholder.color);
    placeholderColor[3] *= Number(placeholder.opacity);
    const hasBorder = parseFloat(css.borderTopWidth) > 0 && css.borderTopStyle !== "none" && rgba(css.borderTopColor)[3] > 0;
    const hasOutline = parseFloat(css.outlineWidth) > 0 && !["none", "hidden"].includes(css.outlineStyle) && rgba(css.outlineColor)[3] > 0;
    const after = getComputedStyle(el, "::after");
    const hasIndicator = !["none", "normal"].includes(after.content) && parseFloat(after.borderTopWidth) > 0 && after.borderTopStyle === "solid" && rgba(after.borderTopColor)[3] > 0;
    const indicatorColor = rgba(after.borderTopColor);
    indicatorColor[3] *= Number(after.opacity);
    return {
      label: (el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || "").trim().slice(0, 100),
      tag: el.tagName, class: el.getAttribute("class"), foreground, background: bg.slice(0, 3),
      ratio: ratio(over(rgba(foreground), bg), bg),
      surfaceRatio: ratio(bg, outer),
      indicatorRatio: hasIndicator ? ratio(over(indicatorColor, over(rgba(after.backgroundColor), bg)), over(rgba(after.backgroundColor), bg)) : null,
      indicatorUnsupported: hasIndicator && (after.backgroundImage !== "none" || Number(after.opacity) < 1),
      placeholderRatio: el.matches("input,textarea") ? ratio(over(placeholderColor, bg), bg) : null,
      // Outer edge only; applicability (essential control vs decoration) needs review.
      borderRatio: hasBorder ? ratio(over(rgba(css.borderTopColor), outer), outer) : null,
      borderInnerRatio: hasBorder ? ratio(over(rgba(css.borderTopColor), bg), bg) : null,
      focusRatio: hasOutline ? ratio(over(rgba(css.outlineColor), outer), outer) : null,
      // A positive outline offset leaves the surrounding surface on both sides.
      focusInnerRatio: hasOutline ? ratio(over(rgba(css.outlineColor), parseFloat(css.outlineOffset) > 0 ? outer : bg), parseFloat(css.outlineOffset) > 0 ? outer : bg) : null,
      outline: css.outline, disabled: el.matches(":disabled,[data-disabled],[aria-disabled=true]"),
      unsupported, fontSize: css.fontSize, fontWeight: css.fontWeight,
    };
  });
  if (target) return { samples, pairs: [] };
  const probe = document.createElement("span"); document.body.append(probe);
  function token(name: string) { probe.style.color = `var(--kodex-${name})`; return rgba(getComputedStyle(probe).color); }
  const pairs = [
    ["text-primary", "bg-panel"], ["text-secondary", "bg-panel"], ["text-muted", "bg-panel"],
    ["text-muted", "bg-selected-strong"], ["text-muted", "bg-button-hover"], ["text-accent", "bg-panel"],
    ["text-on-action", "bg-action"], ["text-on-action", "bg-action-hover"], ["text-on-user-bubble", "bg-user-bubble"],
    ["border-control", "bg-raised-muted"], ["focus-ring", "bg-panel"],
    ["border-subtle", "bg-raised-muted"], ["border-accent-soft", "bg-panel"],
    ...["danger", "warning", "success", "info"].map(tone => [`text-${tone}`, `bg-${tone}`]),
  ].map(([foreground, bg]) => {
    const back = token(bg), front = over(token(foreground), back);
    return { foreground, background: bg, ratio: ratio(front, back), fg: front, bg: back };
  });
  probe.remove(); return { samples, pairs };
}
