---
name: reducer-semantics
description: Vertical velocity reduces with min, elevation slope and everything else with max, and susceptibility uses mean against a 0.5 threshold.
metadata:
  type: project
---

Collapsing a raster to one value per district uses a different reducer per variable, and the choice is
part of the contract rather than an implementation detail.

VV500 and VV700 **min** | elevation and slope **max** | all other CARI variables **max** |
susceptibility conditions **mean**, passing at 0.5.

**Why:** vertical velocity is negative for upward motion, so the strongest updraft is the minimum. A
max there returns near zero and grades 0 where it should grade 5 or 6: plausible and wrong. Elevation
and slope use max so a district is judged on its worst cell. For susceptibility the raster is binary,
so its mean over a polygon is exactly the fraction of area passing.

**How to apply:** `zonal_stat` takes the reducer as an argument, never defaulted. When a score looks
wrong, the reducer is the second thing to check after which matrix was used.

Two quantities are derived at ingest, not per request: hourly rate as
`(current - previous) * 1000 / interval_hours` masked to positive, and wind speed 850 as
`sqrt(u^2 + v^2) * 3.6`. Source precipitation is cumulative since initialization.

Related: [[three-scoring-models]], [[slope-is-computed-at-5km]], [[legacy-precip-lead-zero]]