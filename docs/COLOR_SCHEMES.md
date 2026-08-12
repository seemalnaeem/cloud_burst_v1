# COLOR_SCHEMES.md — Cloud‑Burst Portal Theme & Color System

> The complete UI color system for the portal's **light** and **dark** themes: every design token
> (with both theme values side‑by‑side), the brand palette, borders, gradients, shadows, and the
> fixed/theme‑independent colors. Source of truth: `frontend/src/index.css`.
>
> **Not covered here:** data‑visualization palettes (CARI risk classes, forecast raster ramps, PMD
> radar bins, precipitation‑type colors). Those are map/legend colors, documented in
> [`DATA_SOURCES.md` §10](DATA_SOURCES.md) — see [§9 See also](#9-see-also).

---

## 1. How theming works

- All UI color is expressed as **CSS custom properties** (`--cb-*`) declared on `:root`.
- **Light** is the default (`:root`). **Dark** overrides the same tokens under
  `:root[data-theme="dark"]`.
- The theme is switched by stamping `data-theme="dark"` on the `<html>` element
  (`document.documentElement`). Only the token *values* change — every component reads the tokens, so
  the whole portal re‑themes with **no structural/markup change**.
- A handful of colors are **intentionally fixed in both themes** (brand header, alert red, on‑dark
  white text). Those are listed in [§5](#5-fixed--theme-independent-colors).

```css
:root { --cb-bg: #eef1f6; /* …light… */ }
:root[data-theme="dark"] { --cb-bg: #0c0f16; /* …dark… */ }
```

---

## 2. Design token reference (light ↔ dark)

Every `--cb-*` token, grouped by role. Values are exact.

### 2.1 Surfaces / backgrounds

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-bg` | App background | `#eef1f6` | `#0c0f16` |
| `--cb-bg-2` | Secondary background | `#e7ebf2` | `#10141d` |
| `--cb-panel` | Card / panel surface | `#ffffff` | `#171c26` |
| `--cb-panel-2` | Raised panel (rows, inputs) | `#f7f9fc` | `#1d2330` |
| `--cb-panel-3` | Deeper panel (chips, wells) | `#f1f4f9` | `#232a39` |
| `--cb-track` | Gauge/meter track fill | `rgba(20,45,38,0.16)` | `rgba(255,255,255,0.16)` |

### 2.2 Text

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-text` | Primary text (light: brand teal) | `#256354` | `#eef2f7` |
| `--cb-text-2` | Secondary text | `#5b6672` | `#b6bfcd` |
| `--cb-muted` | Muted / captions | `#8a94a1` | `#97a2b1` |

### 2.3 Borders & dividers

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-border` | Default border | `#e4e8ef` | `#2a3240` |
| `--cb-border-strong` | Emphasized border | `#d6dce6` | `#3a4557` |

### 2.4 Brand / primary

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-primary` | Primary accent (links, active) | `#256354` (teal) | `#5b8bff` (blue) |
| `--cb-primary-soft` | Primary tint fill | `#eaf1fd` | `#17233d` |
| `--cb-primary-border` | Primary border/tree lines | `#cfe0ff` | `#2d4372` |
| `--cb-chip` | Chip background | `#eaf0fb` | `#1a2740` |
| `--cb-chip-text` | Chip text | `#33517d` | `#9fbcf0` |
| `--cb-header` | Header pill background (fixed teal) | `#256354` | `#256354` |
| `--cb-header-2` | Header alt / deep bg | `#171b22` | `#12161f` |

> Note the primary accent **shifts hue** between themes: teal `#256354` in light, blue `#5b8bff` in
> dark (teal loses contrast on the dark surfaces).

### 2.5 Semantic (status) colors

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-danger` | Danger/error text/icon | `#d64541` | `#f0736e` |
| `--cb-danger-soft` | Danger fill | `#fdecec` | `#34201f` |
| `--cb-danger-border` | Danger border | `#f2c4c2` | `#5c3230` |
| `--cb-amber` | Warning/amber | `#c17d18` | `#e2a54c` |
| `--cb-amber-soft` | Amber fill | `#fdf3e3` | `#33280f` |
| `--cb-amber-border` | Amber border | `#f0d3a0` | `#56421d` |
| `--cb-green` | Success/green | `#3f9d55` | `#57bd6f` |
| `--cb-green-soft` | Green fill | `#eef7ee` | `#16281a` |
| `--cb-green-border` | Green border | `#cfe8d4` | `#2c4a33` |

Pattern: each semantic color is a **triplet** — a saturated `base` (text/icon), a `-soft` fill
(pale tint in light, dark muted tint in dark), and a matching `-border`.

### 2.6 Interactive controls

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-toggle-off` | Toggle track (off) | `#c7ced6` | `#3a4557` |
| `--cb-btn-dark` | Dark button background | `#141922` | `#2f6bff` |
| `--cb-btn-dark-text` | Dark button text | `#ffffff` | `#ffffff` |

### 2.7 Per‑parameter stat‑card accents

Used by the historic‑event detail cards (Rainfall / PWAT / Elevation figures + borders + icons). The
dark values are deliberately **lightened & desaturated** so the bold blue numbers stay legible on the
dark teal cards.

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-accent-rain` | Rainfall card accent | `#2a80d1` | `#6ba3e0` |
| `--cb-accent-pwat` | PWAT card accent | `#6366f1` | `#9ea4f0` |
| `--cb-accent-elev` | Elevation card accent | `#0284c7` | `#58b0e0` |

> (Other stat cards use semantic tokens directly: CAPE → `#d97706`, Rel. Humidity → `#0d9488`,
> Vert. Velocity → `#bb1d1d`, Slope → `#059669`. These are card‑local literals, not theme tokens.)

### 2.8 Elevation (shadows)

| Token | Role | ☀️ Light | 🌙 Dark |
|---|---|---|---|
| `--cb-shadow` | Standard shadow | `0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.05)` | `0 1px 2px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.3)` |
| `--cb-shadow-lg` | Large/overlay shadow | `0 8px 30px rgba(16,24,40,0.12), 0 2px 8px rgba(16,24,40,0.06)` | `0 10px 34px rgba(0,0,0,0.5), 0 2px 10px rgba(0,0,0,0.35)` |

Light shadows are cool‑navy and subtle; dark shadows are pure‑black and deeper (needed for
separation on near‑black surfaces).

### 2.9 Shape & type (theme‑independent)

| Token | Value |
|---|---|
| `--cb-radius` | `16px` |
| `--cb-radius-sm` | `10px` |
| `--cb-font` | `'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif` |

---

## 3. Brand palette (the teal family)

The Cloud‑Burst brand is a **teal/green** system. These literals appear across components (not all are
tokenized):

| Swatch | Hex | Usage |
|---|---|---|
| Brand teal (primary) | `#256354` | Header pill, light‑theme primary/text, sliders `accent-color`, CARI action buttons, section header base |
| Brand teal (accent) | `#3D8D7A` | Section left accent bar, active section‑icon background, `--ic` default item accent, "on" icon buttons |
| Brand teal (dark‑btn text) | `#6fb9a6` | `.cari-teal-btn` text in dark theme |
| Brand cream | `#FBFFE4` | Header title/clock text (on the teal header) |
| Header body text | `#f5f7ee` / `#d7dde6` / `#e6ecf5` | Header subtitle / status pill / menu text |
| Toggle‑on / meter accent | `#256354` (light) | Range inputs `accent-color`, toggle knobs, gauges |

The green‑tinted **point‑detail cards** use `rgba(61,141,122, …)` (that's `#3D8D7A`) at 0.15–0.23
opacity as their surface tint in both themes.

---

## 4. Gradients

### 4.1 Sidebar section headers (`.cb-section`) — teal opacity ramp

Same teal (`rgba(37,99,84,…)` = `#256354`) layered at increasing opacity by state. In **dark** theme
the gradient is composited over a solid dark base so it doesn't wash out.

| State | ☀️ Light | 🌙 Dark |
|---|---|---|
| Rest | `linear-gradient(135deg, rgba(37,99,84,0.18) 0%, rgba(37,99,84,0.05) 100%)` | `linear-gradient(135deg, rgba(37,99,84,0.80) 0%, rgba(37,99,84,0.10) 100%), #1a2029` |
| Hover | `linear-gradient(135deg, rgba(37,99,84,0.26) 0%, rgba(37,99,84,0.09) 100%)` | `…rgba(37,99,84,0.28)…rgba(37,99,84,0.10)…, #1d2531` |
| Open / active | `linear-gradient(135deg, rgba(37,99,84,0.32) 0%, rgba(37,99,84,0.12) 100%)` | `…rgba(37,99,84,0.34)…rgba(37,99,84,0.14)…, #1f2836` |

Borders track the state: light `rgba(37,99,84, 0.32→0.5→0.6)`; dark `rgba(61,141,122, 0.45→0.6→0.7)`.
Open state adds a left accent bar `#3D8D7A`.

### 4.2 Alert banner accent

`linear-gradient(90deg, #b91c1c, #dc2626)` — red alert header strip (theme‑independent).

### 4.3 Legend gradients

Forecast/CARI legend swatches render a `linear-gradient(to right, …palette…)` built at runtime from
the data palettes (see [`DATA_SOURCES.md` §10](DATA_SOURCES.md)); the gradient bar has an inset hairline
`inset 0 0 0 1px rgba(16,24,40,0.06)`.

---

## 5. Fixed / theme‑independent colors

These do **not** change between themes:

| Element | Color(s) |
|---|---|
| **Header pill** (`.topbar`) | Background `--cb-header` = `#256354` (teal in both themes); border `rgba(255,255,255,0.06)` |
| Header title / clock | `#FBFFE4` (cream) |
| Header subtitle | `#f5f7ee` |
| Header status pill | text `#d7dde6`, bg `rgba(255,255,255,0.08)`, border `rgba(255,255,255,0.1)` |
| **Alert red** | primary `#b91c1c`; bright `#dc2626`; hover `#a31616`; border `#f0b4b4` / `#7f1d1d`; alert‑item left border `4px #b91c1c` |
| Alert pulse | `box-shadow: 0 0 0 0 rgba(185,28,28,0.55) → 0 0 0 6px rgba(185,28,28,0)` |
| **Section title text** | `#14181d` (light) → `#ffffff` (dark) |
| **Section icon bubble** | background `#3D8D7A`, icon `#ffffff` |
| Item name text | `#14181d` (light) → `#ffffff` (dark) |
| Toggle knob | `#ffffff` with `box-shadow: 0 1px 3px rgba(16,24,40,0.25)` |
| On‑map overlays / menus | dark surfaces `#1f2733` / `rgba(24,32,45,0.35)`, text `#ffffff`/`#e6ecf5` |

---

## 6. Scrollbars

Custom WebKit scrollbars (sidebar, legend content):

| Part | Color |
|---|---|
| Track | transparent |
| Thumb | `#d3d9e2` |
| Thumb hover | `#bcc4d0` |

---

## 7. Component → token map (quick reference)

| Component | Key tokens |
|---|---|
| App shell / container | `--cb-bg`, `--cb-text` |
| Header pill | `--cb-header` (fixed teal), literal `#FBFFE4` text, `--cb-shadow` |
| Sidebar sections | teal‑opacity gradients (§4.1), `--cb-primary-border` tree lines |
| Cards / panels | `--cb-panel`, `--cb-panel-2/3`, `--cb-border`, `--cb-border-strong`, `--cb-shadow` |
| Buttons (primary) | `--cb-primary`, `--cb-primary-soft`; teal `.cari-teal-btn` uses `color-mix(#256354 …)` |
| Toggles / sliders | `--cb-toggle-off`, `accent-color:#256354`, knob `#fff` |
| Chips | `--cb-chip`, `--cb-chip-text` |
| Status: danger / warn / ok | `--cb-danger*`, `--cb-amber*`, `--cb-green*` |
| Alerts module | fixed red family (§5) |
| Stat cards (event detail) | `--cb-accent-rain/pwat/elev` + literals (CAPE/RH/VV/slope) |
| Legends | data palettes ([`DATA_SOURCES.md`](DATA_SOURCES.md)) + `--cb-panel`, text `#14181d`↔`#fff` |
| Muted text / captions | `--cb-muted`, `--cb-text-2` |

---

## 8. Design principles (observed)

1. **Token‑driven** — never hardcode a theme color in a component when a `--cb-*` token exists; the
   dark theme is "free" because it only re‑declares tokens.
2. **Hue‑shift the primary** — teal reads as premium/brand on light surfaces; on near‑black it lacks
   contrast, so dark theme swaps the interactive primary to blue (`#5b8bff`).
3. **Semantic triplets** — every status color ships as `base` + `-soft` (fill) + `-border`; `-soft`
   is a pale tint in light and a dark muted tint in dark.
4. **Keep the brand header constant** — the teal header pill and its cream text are identical in both
   themes for brand recognition.
5. **Readability guardrails** — where a saturated accent drops below usable contrast on dark
   surfaces, add a lightened dark‑theme override (see the `--cb-accent-*` stat‑card blues).
6. **Shadows re‑tuned per theme** — cool‑navy low‑alpha in light; pure‑black higher‑alpha in dark.

---

## 9. See also

- **Map / data‑visualization palettes** (CARI 7‑class risk colors, susceptibility 5‑class,
  `CONTINUOUS_PALETTE`, DEM ramps, precipitation‑type map, PMD radar legend bins): documented in
  [`DATA_SOURCES.md` §10 — Numeric indicators, palettes & legends](DATA_SOURCES.md).
- **Source of truth for these tokens:** `frontend/src/index.css` (`:root` and
  `:root[data-theme="dark"]` blocks).

---

*Generated from `frontend/src/index.css`. To retheme: edit the two `:root` blocks — every component
inherits automatically.*
