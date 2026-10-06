#!/usr/bin/env python3
"""Assemble captured Chromium screenshots; requires Pillow, no browser or network.
Usage: python3 scripts/build-theme-contact-sheet.py ../../artifacts/theme-audit
"""
import argparse
import html
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

SCHEMES = [("oled-black", "OLED Black"), ("paper-light", "Paper Light"), ("dracula", "Dracula"), ("monokai", "Monokai")]
SCREENS = [
    ("01-primitives", "Primitive workbench"), ("08-chat", "Chat, composer and Markdown"),
    ("09-preferences", "Preferences / selected buttons"), ("10-notifications", "Notifications / status"),
    ("14-preferences-touch", "390px touch preferences"), ("11-preferences-narrow", "390px fine-pointer preferences"),
    ("02-menu", "Menu / selected item"), ("03-select", "Select / keyboard option"),
    ("04-popover", "Popover and tooltip"), ("05-input-focus", "Focused input"),
    ("06-modal", "Modal"), ("07-drawer", "Drawer"),
    ("12-button-hover", "Hovered subtle button"), ("13-button-focus", "Keyboard-focused light button"),
]

def font(size):
    for name in ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)

def source(root, scheme, key):
    detail = root / scheme / f"{key}-detail.png"
    return detail if detail.exists() else root / scheme / f"{key}.png"

def sheet(root, schemes, rows, filename, width=600, height=460):
    thumbnails = []
    for key, _ in rows:
        images = []
        for scheme, _ in schemes:
            with Image.open(source(root, scheme, key)) as image:
                images.append(ImageOps.contain(image.convert("RGB"), (width - 14, height - 10), Image.Resampling.LANCZOS))
        thumbnails.append(images)
    row_heights = [max(image.height for image in images) + 60 for images in thumbnails]
    canvas = Image.new("RGB", (width * len(schemes) + 40, sum(row_heights) + 112), "#edf0f4")
    draw = ImageDraw.Draw(canvas)
    draw.text((20, 14), "KODEX / THEME CONTRAST AUDIT", font=font(27), fill="#182334")
    draw.text((20, 50), "Chromium · current checkout · synthetic app data · see index.html for full-resolution captures", font=font(16), fill="#42516a")
    for col, (_, label) in enumerate(schemes):
        draw.text((26 + col * width, 82), label, font=font(23), fill="#182334")
    y = 112
    for row, (_, title) in enumerate(rows):
        for col, (scheme, _) in enumerate(schemes):
            x = 20 + col * width
            draw.text((x + 6, y + 6), title, font=font(18), fill="#24344c")
            thumb = thumbnails[row][col]
            canvas.paste(thumb, (x + 6 + (width - 14 - thumb.width) // 2, y + 40))
        y += row_heights[row]
    canvas.save(root / filename)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    root = parser.parse_args().directory.resolve()
    global SCHEMES
    manifests = sorted(root.glob("*/theme.json"))
    if manifests:
        definitions = [json.loads(file.read_text()) for file in manifests]
        SCHEMES = [(item["id"], item["label"]) for item in sorted(definitions, key=lambda item: (item["mode"], item["label"]))]
    # Fail on missing output instead of silently producing an incomplete comparison.
    for scheme, _ in SCHEMES:
        for key, _ in SCREENS:
            if not (root / scheme / f"{key}.png").exists():
                raise SystemExit(f"Missing capture: {scheme}/{key}.png")
    sheet_links = []
    for start in range(0, len(SCHEMES), 4):
        schemes = SCHEMES[start:start + 4]
        suffix = "" if start == 0 else f"-{start // 4 + 1:02d}"
        for name, rows, width, height in [
            ("contact-sheet", SCREENS[:5], 600, 540),
            ("primitives-contact-sheet", [SCREENS[0]], 1000, 1020),
            ("overlays-contact-sheet", SCREENS[6:12], 600, 490),
            ("states-contact-sheet", [SCREENS[5], SCREENS[9], *SCREENS[12:]], 600, 540),
        ]:
            filename = f"{name}{suffix}.png"
            sheet(root, schemes, rows, filename, width, height)
            sheet_links.append(f'<a href="{filename}">{name} {start // 4 + 1}</a>')
    cells = []
    for key, title in SCREENS:
        cells.append(f'<h2 id="{key}">{html.escape(title)}</h2><div class="grid">')
        for scheme, label in SCHEMES:
            raw = f"{scheme}/{key}.png"
            preview = source(root, scheme, key).relative_to(root).as_posix()
            cells.append(f'<figure><figcaption>{label}</figcaption><a href="{raw}"><img loading="lazy" src="{preview}" alt="{html.escape(title)} — {label}"></a></figure>')
        cells.append('</div>')
    labels = ["Subtle", "Light", "Filled", "Outline", "Filled action", "Mantine dimmed text on panel", "Kodex muted text on panel"]
    table = ['<table><tr><th>Theme</th>' + ''.join(f'<th>{label}</th>' for label in labels) + '</tr>']
    data = {scheme: json.loads((root / scheme / "measurements.json").read_text())["01-primitives"] for scheme, _ in SCHEMES}
    for scheme, theme_label in SCHEMES:
        table.append(f'<tr><th>{html.escape(theme_label)}</th>')
        for label in labels:
            entry = next(s for s in data[scheme]["samples"] if s["label"] == label)
            ratio = entry["ratio"]
            threshold = 3 if label == "Filled action" else 4.5
            table.append(f'<td class="{"fail" if ratio < threshold else "pass"}">{ratio:.2f}:1</td>')
        table.append('</tr>')
    table.append('</table>')
    navigation = ' · '.join(f'<a href="#{key}">{html.escape(title)}</a>' for key, title in SCREENS)
    document = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kodex theme contrast audit</title>
<style>body{margin:32px;background:#eef1f5;color:#182334;font:16px/1.5 system-ui}h1{margin-bottom:6px}h2{margin-top:44px}a{color:#164f9a}nav{max-width:1100px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}figure{margin:0;background:white;border:1px solid #cad0d9;padding:8px;align-self:start}figcaption{font-weight:650;margin-bottom:8px}img{width:100%;height:auto}table{border-collapse:collapse;margin:24px 0;background:white}th,td{border:1px solid #c7cfdc;padding:10px;text-align:left}.fail{background:#ffe5e2;color:#8c1d16}.pass{background:#e0f1e8;color:#145333}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}body{margin:16px}}@media(max-width:500px){.grid{grid-template-columns:1fr}}</style>
<h1>Kodex theme contrast audit</h1><p>Current checkout • THEME_COUNT themes • CAPTURE_COUNT browser captures • synthetic app data.</p>
<p>Click any image for the full-resolution screen. Comparisons show the captured styling; use the measurements to check the rendered pairs. Background content behind modal scrims is intentionally dimmed.</p>
<p><a href="contact-sheet.png">Overview sheet</a> · <a href="primitives-contact-sheet.png">Primitives sheet</a> · <a href="overlays-contact-sheet.png">Overlays sheet</a> · <a href="states-contact-sheet.png">States sheet</a></p>
'''
    document = document.replace('THEME_COUNT', str(len(SCHEMES))).replace('CAPTURE_COUNT', str(len(SCHEMES) * len(SCREENS)))
    document += '<p>' + ' · '.join(sheet_links) + '</p>'
    document += ''.join(table) + '<p>Computed sRGB foreground/background ratios; text target 4.5:1, filled action icon target 3:1. Flat surfaces only. Disabled controls, gradients, opacity chains and overlay-obscured controls are not classified here. Detailed JSON is diagnostic, not a conformance scan.</p><nav>' + navigation + '</nav>' + ''.join(cells) + '</html>'
    (root / "index.html").write_text(document)
    print(root / "index.html")

if __name__ == "__main__":
    main()
