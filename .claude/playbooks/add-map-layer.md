# Playbook: add a map layer

Owner: `frontend-agent`, plus `db-agent` for the tile function.

Vector for discrete clickable features, raster for continuous fields.

**Vector.** Add the MVT function (template in
[postgis-patterns](../skills/postgis-patterns/SKILL.md)), grant execute, restart `cbd-tiles`, confirm
in `/index.json`. Then add the definition to `shared/contracts/layers.json`: id, `tileFunction`,
`sourceLayer`, label, `labelField`, `defaultVisible`, `minzoom`, `properties`, `paint`.

**Raster.** Register the COG in `wx.raster_catalog`, then add the band to `bands.json` with `min`,
`max`, `palette` and `legendTitle`. Min and max drive both the tile rescale and the legend ticks, so
they cannot drift apart.

**Render.** The map iterates the contract, so a new entry appears automatically. If you need a
component special case, the contract is missing a field; add the field. Rasters go below all vectors
so boundaries stay readable. Legends are generated from the contract, never hand written: continuous
palettes as a gradient with ticks, classed as discrete swatches with labels. Hover uses feature
state, not a source re-render, which visibly stutters on a district layer.

## Verify

Toggles cleanly, renders in light and dark, legend matches the map (same palette, same min and max),
tiles return 200 at a plausible size, no stutter at minzoom, popup shows the right fields, works from
a LAN address.

## Common problems

| Symptom | Cause |
|---|---|
| Invisible but tiles are 200 | `sourceLayer` must match the name inside `ST_AsMVT` exactly |
| Tiles enormous | generalization not applied; check the zoom tier in the function |
| Right in light, wrong in dark | a hex literal crept into a component |
| Legend and map disagree | two sources of truth for min and max; both must come from `bands.json` |