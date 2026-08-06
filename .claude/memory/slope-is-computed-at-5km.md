---
name: slope-is-computed-at-5km
description: The legacy scoring computes slope from a 5 km reduced DEM, not the native 30 m DEM, making slope far gentler than a naive gdaldem reproduction.
metadata:
  type: project
---

`app.py` district scoring:

```python
dem_5km    = dem_native.reduceResolution(max).reproject(@5000m)
slope_5km  = ee.Terrain.slope(dem_5km)          # slope FROM the 5 km DEM
slope_28km = slope_5km.reduceResolution(max).reproject(@28000m)
```

Line 2 is the point: slope derives from the already-reduced 5 km DEM, not native 30 m. Repeats
identically at lines 1438, 1732, 2056, 2161, 2650, 2904, 3218, 3489, covering CARI, the hotspot mask,
susceptibility and alerts.

**Why it matters:** slope over a 5 km run is far gentler than the same terrain over 30 m. A valley
wall reading 40 degrees at 30 m may read under 10 at 5 km. CARI thresholds are `[3,8,15,25,35,45]`
and both boolean models test slope at 15. A `gdaldem` reproduction on a native DEM plus zonal max
would push every mountainous district up and fire the slope condition far more often. Plausible,
silent, wrong.

**How to apply:** resample first, derive slope second.

```bash
gdalwarp -tr 0.0449 0.0449 -r max -t_srs EPSG:4326 dem_native.tif dem_5km.tif
gdaldem slope -compute_edges -s 111120 dem_5km.tif slope_5km.tif
gdalwarp -tr 0.2513 0.2513 -r max slope_5km.tif slope_28km.tif   # and the DEM likewise
```

0.0449 and 0.2513 degrees are 5 km and 28 km at this latitude; recompute if the AOI moves.

The per-pixel CARI raster deliberately uses **native** terrain: reducing it to 28 km made a district
render as one flat colour. Keep the paths distinct.

**Open question for the owner:** reproduce faithfully, or move to native-resolution slope? Native is
arguably better science for cloudburst risk, where a steep catchment wall matters more than a
regional gradient, but it shifts every historical score. Both paths are in `cari.json`
`terrainReduction`; the validator enforces the 5 km derivation.

Related: [[reducer-semantics]], [[three-scoring-models]]