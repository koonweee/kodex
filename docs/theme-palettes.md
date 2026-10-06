# Theme palette sources

Kodex ships the original OLED Black, Paper Light, Dracula and Monokai themes plus 36 adaptations from the families below, for 40 themes in total. These are app adaptations of recognizable palette foundations, not complete upstream editor themes. Nord Light is explicitly a Kodex adaptation of the Snow Storm palette; Nord itself does not publish a separate light theme.

The seed catalog lives in [`themePalettes.ts`](../apps/web/src/theme/themePalettes.ts). The shared [`paletteTheme.ts`](../apps/web/src/theme/paletteTheme.ts) maps each seed's independently sourced canvas, shell, content, raised surface, ink, accent and semantic colors to the complete [`tokenContract.ts`](../apps/web/src/theme/tokenContract.ts). The four original themes retain their explicit definitions in the registry.

| Family | Included variants | Canonical palette reference | Upstream license |
| --- | --- | --- | --- |
| Catppuccin | Latte, Mocha, Macchiato, Frappé | [Palette JSON](https://github.com/catppuccin/palette/blob/main/palette.json) | MIT |
| Rosé Pine | Dawn, Rosé Pine, Moon | [Palette definitions](https://github.com/rose-pine/neovim/blob/main/lua/rose-pine/palette.lua) | MIT |
| Tokyo Night | Day, Night, Storm, Moon | [Color definitions](https://github.com/folke/tokyonight.nvim/tree/main/lua/tokyonight/colors), [generated Day colors](https://github.com/folke/tokyonight.nvim/blob/main/extras/wezterm/tokyonight_day.toml) | Apache-2.0 |
| GitHub | Light, Light High Contrast, Dark, Dark Dimmed, Dark High Contrast | [Official VS Code color mapping](https://github.com/primer/github-vscode-theme/blob/main/src/colors.js), [Primer Primitives](https://github.com/primer/primitives) | MIT |
| Solarized | Light, Dark | [Canonical palette](https://github.com/altercation/solarized#the-values) | MIT |
| Gruvbox Material | Light, Dark | [Palette definitions](https://github.com/sainnhe/gruvbox-material/blob/master/autoload/gruvbox_material.vim) | MIT |
| Everforest | Light, Dark | [Palette definitions](https://github.com/sainnhe/everforest/blob/master/autoload/everforest.vim) | MIT |
| Ayu | Light, Dark, Mirage | [Theme YAML](https://github.com/ayu-theme/ayu-colors/tree/master/themes) | MIT |
| Kanagawa | Lotus, Wave, Dragon | [Palette definitions](https://github.com/rebelot/kanagawa.nvim/blob/master/lua/kanagawa/colors.lua) | MIT |
| Atom One | Light, Dark | [One Light colors](https://github.com/atom/one-light-syntax/blob/master/styles/colors.less), [One Dark colors](https://github.com/atom/one-dark-syntax/blob/master/styles/colors.less) | MIT |
| Nord | Nord, Nord Light | [Nord palette](https://github.com/nordtheme/nord/blob/develop/src/nord.scss) | MIT |
| Edge | Light, Dark, Aura, Neon | [Palette definitions](https://github.com/sainnhe/edge/blob/master/autoload/edge.vim) | MIT |

Upstream permission and copyright notices are retained in [`licenses/theme-palettes.txt`](licenses/theme-palettes.txt). No upstream component, editor integration or runtime dependency is copied. Names identify palette inspiration and do not imply endorsement.

## App adaptations

Editor palettes often reserve low contrast colors for comments, inactive gutters or selected backgrounds. Kodex needs readable metadata, placeholders, menus and form controls across multiple surfaces. Each palette therefore supplies its own foundations, and the common generator adapts foregrounds toward white or black only as much as needed to clear every supported neutral, hover and selection surface. Default text and status authoring targets use headroom above 4.5:1; the high contrast GitHub variants target at least 7:1 in generated neutral/status pairs.

Solid actions use a separate foreground selected for their theme mode. Action hover preserves that pairing. User bubbles keep white body/link ink and a sufficiently dark accent-derived fill, independently from solid action colors. Statuses derive distinct subtle fills from each family's danger/warning/success/info seed and fit the matching status foreground against both that fill and the neutral surfaces. Focus uses an opaque desaturated control-boundary color, keeping essential edge contrast without a bright accent rectangle.

The generator is an authoring aid, not acceptance evidence. It evaluates opaque sRGB pairs in the registry; effective CSS, portals, native marks and composed component states still require the rendered contrast gate and contact-sheet inspection described in [theme guidelines](theme-guidelines.md). If a new palette cannot reach its authoring targets, generation fails instead of silently substituting another theme. A new component should continue using semantic token pairs rather than reading the seeds or Mantine ramps.
