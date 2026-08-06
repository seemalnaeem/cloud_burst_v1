# Data contracts

Every number describing the science or the visual language lives in
[shared/contracts/](../../shared/contracts/), read through one thin loader per tier.

| File | Holds |
|---|---|
| `cari.json` | matrices, weights, reducers, classes, override, `terrainReduction` |
| `hotspot.json` / `susceptibility.json` | the two 13-condition sets |
| `bands.json` | keys, units, display ranges, derived formulas |
| `palettes.json` | ramps, classed palettes, categorical map, radar bins |
| `layers.json` / `ports.json` / `time.json` | layers, port map, lead grid |

Loaders: `backend/app/shared/contracts.py`, `middleware/src/lib/contracts.js`,
`frontend/src/lib/contracts.js`. Read through them, not `open()` or `fs`; they validate, cache and
strip `$`-prefixed comment keys.

**Why:** section 12 of DATA_SOURCES.md records what duplicated constants did to the old system. The
rain threshold had three values depending on where you looked; the wind threshold in code disagreed
with the comment above it; the UI reported 7, 12 or 13 conditions depending on the panel.

## The rules, not the detail

Model mechanics live in [cari-scoring](../skills/cari-scoring/SKILL.md); the reasoning lives in
[memory](../memory/). Here are only the invariants:

- The three models share variables at **deliberately different** thresholds. Never reconcile them.
  [[three-scoring-models]]
- Reducers are part of the contract: VV **min**, elevation and slope **max**, susceptibility **mean**
  against 0.5. [[reducer-semantics]]
- Slope derives from the **5 km** DEM, not native. Enforced by the loader validator.
  [[slope-is-computed-at-5km]]
- `district_name` is an exact-string join key. [[join-key-discipline]]
- CARI's 7 classes and susceptibility's 5 share hex values with different meanings. `#fdae61` is
  Moderately High in one, High in the other. Never merge.
- Precipitation type codes 2, 4, 9, 10, 11 are unused and render as dark filler. A deliberate wart,
  noted in `palettes.json` so nobody fixes it by accident.

## Changing a contract

Announce it, edit the JSON, update loader validation if the shape changed, run contract tests in all
three tiers, update golden scoring tests in the same commit, and note non-obvious reasoning in
[memory](../memory/). It touches all five agents; never a quiet edit.