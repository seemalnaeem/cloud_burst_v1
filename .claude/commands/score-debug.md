---
description: Work out why a district score looks wrong, in the order that finds it fastest.
argument-hint: <district name> [forecast hours]
---

Score looks wrong for: $ARGUMENTS

Check in this order, ordered by how often each is the cause. Report findings at each step, then state
the cause and fix.

1. **Which matrix** (in the response as `matrix`). Terrain and lowlands differ on six of thirteen
   variables: CAPE, TCWV, ELEV, DP, T2M, T850.
2. **Which reducer.** VV500 and VV700 use **min**, everything else max. A max on VV700 returns near
   zero and grades 0 where it should grade 5 or 6. Silent, plausible, wrong.
3. **Was precipitation differenced.** Cumulative used as a rate saturates the rainfall grade.
4. **Slope resolution.** Derived from the 5 km DEM, not native. Native inflates mountain districts
   and both boolean models test slope at 15 degrees. See [[slope-is-computed-at-5km]].
5. **Lead 0.** The rain rate needs the 0-to-3 delta or every rain condition reads zero. See
   [[legacy-precip-lead-zero]].
6. **Which model.** CARI, hotspot and susceptibility use deliberately different thresholds;
   susceptibility is uniformly stricter. Confirm you are comparing like with like.
7. **Was the override applied** (`overrideApplied`). It raises a class and never lowers, so a class
   above what the percentage suggests is the rule working.
8. **Input sanity.** `gdallocationinfo -valonly -wgs84 <cog> <lon> <lat>`. All zeros usually means
   the wrong band index; a uniform field usually means a nodata problem. Check units: GFS ships
   Kelvin.
9. **Geometry validity.** `SELECT ST_IsValidReason(geom) FROM geo.districts WHERE district_name=...`
   Invalid geometry makes zonal stats return nothing with no error.

If every step passes, the score is probably right and the expectation needs checking.