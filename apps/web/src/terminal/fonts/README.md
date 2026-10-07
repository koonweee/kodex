# Terminal symbols

`SymbolsNerdFontMono-Regular.woff2` is the unmodified glyph set from Nerd Fonts v3.4.0, converted from TTF to WOFF2 with fontTools (Brotli compression).

Source: https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/NerdFontsSymbolsOnly

The adjacent LICENSE is the upstream Symbols Only license. The font is scoped to its symbol codepoints, ahead of the terminal's existing monospace stack; ordinary text keeps its existing font. Loaded from the same origin, with no external font service.

To regenerate, download `SymbolsNerdFontMono-Regular.ttf` from the pinned source, then use fontTools:

```python
from fontTools.ttLib import TTFont
font = TTFont("SymbolsNerdFontMono-Regular.ttf")
font.flavor = "woff2"
font.save("SymbolsNerdFontMono-Regular.woff2")
```
