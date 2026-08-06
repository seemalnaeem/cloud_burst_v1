---
name: ui-theming
description: The cb design token system, Tailwind 4 setup, light and dark theming, react-icons usage. Use when styling a component, adding a color, building a legend or working on dark mode. Triggers on theme, dark mode, token, Tailwind, color, css variable, icon, react-icons, legend, palette.
---

# UI theming

Tokens from [COLOR_SCHEMES.md](../../../COLOR_SCHEMES.md). Data palettes from `palettes.json`. **Two
different systems**, and confusing them is the most common styling mistake here.

## How it works

Every UI color is a `--cb-*` property on `:root`; dark redeclares the same names under
`:root[data-theme="dark"]`. Switching stamps the attribute on `document.documentElement`; markup
never changes. `index.html` reads the stored value before React mounts, avoiding a light-theme flash.

## Tailwind 4

Vite plugin only. No `tailwind.config.js`, no PostCSS config, no content array.

```css
@import 'tailwindcss';
@import './tokens.css';

@theme inline {
  --color-panel: var(--cb-panel);
  --color-text:  var(--cb-text);
  --radius-cb:   var(--cb-radius);
}
```

**`inline` is required.** Without it Tailwind resolves the variable at build time, freezes the light
value, and dark mode silently does nothing.

```jsx
<div className="bg-panel text-text border border-border rounded-cb shadow-cb p-4">   // yes
<div style={{ background: '#ffffff' }}>                                              // no
```

## Tokens

Surfaces `--cb-bg`, `-panel`, `-panel-2/3` | Text `-text`, `-text-2`, `-muted` | Borders `-border`,
`-border-strong` | Brand `-primary(+soft/border)`, `-chip`, `-header` | Status `-danger`, `-amber`,
`-green` each with `-soft` and `-border` | Controls `-toggle-off`, `-btn-dark`, `-knob` | Stat
accents `-accent-rain/pwat/elev` | `-shadow`, `-radius`, `-font`

Decisions embedded in the values:

- The primary **shifts hue** between themes: teal light, blue dark, because teal loses contrast on
  near-black.
- Status colors are always a triplet: saturated base, `-soft` fill, matching `-border`.
- The header pill, its cream text and the alert red family are **fixed in both themes** on purpose.
  Do not "fix" them for dark mode.
- Shadows retune per theme; stat accents lighten in dark so bold numbers stay legible.

## Data palettes are not theme

Map colors describe data and are identical in both themes.

```js
import { cariClasses } from '@/lib/contracts'
const cls = cariClasses().find(c => value <= c.max)
```

CARI has 7 classes, susceptibility 5, sharing hex values with different meanings; radar legends have
16 bins. All in `palettes.json`, never retyped. Legend gradients build at runtime from the palette
array.

## Icons

```jsx
import { FiLayers } from 'react-icons/fi'    // yes, specific set
import { FiLayers } from 'react-icons'       // no, pulls every family
```

Lucide banned and not installed; eslint rejects both mistakes. `react-icons/wi` is the weather set.
Decorative icons get `aria-hidden="true"`, meaningful ones an `aria-label`. Sizes: 14 inline, 16
controls, 18 section headers, 22 feature.

## Responsive and accessible

Sidebar collapses under 1024 px, legends become a bottom sheet. Body text reaches 4.5:1; verify any
new pairing. Never encode meaning in color alone, a risk class shows its label beside the swatch.
Keep focus rings.