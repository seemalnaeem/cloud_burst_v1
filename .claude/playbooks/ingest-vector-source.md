# Playbook: ingest a vector source

Owner: `geoprocessing-agent` (1-5), `db-agent` (6-7). Commands in
[gdal-toolbox](../skills/gdal-toolbox/SKILL.md), SQL in
[postgis-patterns](../skills/postgis-patterns/SKILL.md).

**1. Register** in `meta.sources` (name, kind, origin, notes). Six months from now "where did this
come from" is a real question.

**2. Inspect.** `ogrinfo -al -so`. Confirm CRS, feature count, exact field names and casing,
geometry type. Expected: districts ~167, tehsils ~554, provinces 8, IIOJK 64 after filtering. An
unexpected count is not automatically wrong (Pakistan keeps creating districts) but **stop and ask**.

**3. Stage.** `ingest_vector.py --file <path> --target districts`. Staging always; a half-finished
ingest into a live table leaves the portal with no boundaries.

**4. Validate.**

```sql
SELECT count(*), count(*) FILTER (WHERE NOT ST_IsValid(geom) OR geom IS NULL) FROM geo.districts_staging;
SELECT count(*) - count(DISTINCT "Districts") AS dupes FROM geo.districts_staging;
SELECT ST_Extent(geom) FROM geo.districts_staging;
```

The extent catches a wrong CRS immediately: Pakistan is roughly 60-78 E, 23-38 N. Values in the
millions mean projected coordinates that never got transformed.

**5. Promote** in a transaction with a row-count assertion, then `geo.rebuild_generalized()`. The
assertion is the point: a source that returned three features should abort, not replace 167
districts with three.

**6. Verify the join key.** `SELECT * FROM meta.check_integrity();` Orphaned score rows mean the key
changed; fix now or downstream data goes missing with no error.

If names differ from the previous set: diff into exact matches, near matches and one-sided names.
Near matches get an explicit alias row reviewed one at a time; the trigram index *finds* candidates,
it never decides. One-sided names are new districts, renames or splits, each needing a decision.
Never fuzzy match a join key silently. [[join-key-discipline]]

**7. Tiles.** Add the MVT function if new, grant execute, restart `cbd-tiles`, then fetch a tile
through the gateway. 200 with a few KB is right; 0 bytes means an empty tile (bbox or source-layer
name mismatch); hundreds of KB means generalization is not applied.

**8. Finish.** Add the layer to `shared/contracts/layers.json`, log the run in `meta.ingest_runs`.