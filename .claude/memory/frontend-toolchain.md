---
name: frontend-toolchain
description: Vite with Tailwind 4 and react-icons is fixed by the project owner, and Lucide icons are explicitly banned.
metadata:
  type: feedback
---

Specified at project start: **Vite**, **Tailwind**, **react-icons**. Lucide named specifically as not
to be used.

**Why:** owner requirement. Tailwind 4 via `@tailwindcss/vite` also needs no PostCSS config and no
content array, removing two files that go stale, and react-icons covers the weather domain without a
second dependency.

**How to apply:**

- `@tailwindcss/vite` only. No `tailwind.config.js`, no `postcss.config.js`.
- The `@theme inline` block maps `--cb-*` tokens to utilities. **`inline` is required**: without it
  the utility freezes the light value at build time and dark mode silently stops working.
- Import icons from a specific set (`react-icons/tb` is the portal default), never the root, which
  pulls every family. The eslint config rejects the root import, `lucide-react`, and **`react-icons/lu`**,
  which is Lucide shipped inside react-icons and is the obvious way to break this rule by accident.
- No CSS-in-JS, no component library, no Create React App.
- `eslint-plugin-react` is present only for `jsx-uses-vars` and `jsx-uses-react`. Without them every
  component and icon imported for JSX reports as an unused variable, and 57 false warnings buried two
  real errors.

**No gradients anywhere**, added 2026-08-06 by the owner. This overrides
[COLOR_SCHEMES.md](../../COLOR_SCHEMES.md) section 4, which documents a teal opacity ramp for section
headers and a red ramp for the alert strip. State is carried by flat fills plus a left accent bar
instead, which keeps the three states distinct without a gradient. Continuous data palettes render as
touching solid blocks; there is deliberately no gradient helper in `lib/color.js`, only
`paletteColors`. That is also more honest, since those palettes are a fixed list of stops and a CSS
gradient invents the colours between them.

**Layer identity colours** live in `shared/contracts/layers.json` as one `color` per layer. The fill,
the outline and the legend swatch all read that single value, so a legend cannot drift from its map.
They are data identity, not theme, so they do not change between light and dark, exactly like the
risk palettes.

Related: [[contracts-single-source]], [[no-authenticated-sources]]