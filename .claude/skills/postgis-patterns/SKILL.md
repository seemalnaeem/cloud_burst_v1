---
name: postgis-patterns
description: PostGIS schema, indexing, generalization, MVT functions and zonal query patterns for the cari database. Use when writing SQL, designing tables, tuning spatial queries or serving vector tiles. Triggers on PostGIS, ST_, MVT, vector tile, spatial index, GiST, SRID, simplify.
---

# PostGIS patterns

Database `cari`, port 5545, user `cbd_user`. Extensions: `postgis`, `postgis_raster`, `btree_gist`,
`pg_trgm`. The last earns its place because advisory text names districts inconsistently.

## Boundary table

```sql
district_name text NOT NULL,                    -- join key, exact source casing
district_key  text GENERATED ALWAYS AS
                (upper(regexp_replace(district_name,'[^A-Za-z]','','g'))) STORED,
geom     geometry(MultiPolygon, 4326) NOT NULL,
geom_z6  geometry(MultiPolygon, 4326),          -- 0.05 deg, ~5.5 km
geom_z9  geometry(MultiPolygon, 4326)           -- 0.01 deg, ~1.1 km
```

Indexes: GiST on every geometry column, unique btree on `district_name`, GIN trigram on
`district_name`. `district_key` is generated so it cannot drift and is for fuzzy **search** only.
Never join on it.

## Generalization

```sql
UPDATE geo.districts SET
  geom_z6 = ST_MakeValid(ST_SimplifyPreserveTopology(geom, 0.05)),
  geom_z9 = ST_MakeValid(ST_SimplifyPreserveTopology(geom, 0.01));
```

Full-resolution boundaries were 175 MB. `PreserveTopology` stops collapse; `ST_MakeValid` cleans up
because simplification sometimes produces invalid rings. Each polygon simplifies independently so
adjacent ones develop hairline gaps; if visible use `ST_CoverageSimplify` (PostGIS 3.4+).

## Validity

```sql
SELECT id, district_name, ST_IsValidReason(geom) FROM geo.districts WHERE NOT ST_IsValid(geom);
UPDATE geo.districts SET geom = ST_MakeValid(geom) WHERE NOT ST_IsValid(geom);
```

Run after every ingest. Invalid geometry makes `ST_Intersects` return false with **no error**, so a
district silently vanishes.

## MVT function

```sql
bounds := ST_TileEnvelope(z, x, y);
col := CASE WHEN z < 7 THEN 'geom_z6' WHEN z < 10 THEN 'geom_z9' ELSE 'geom' END;
EXECUTE format($f$
  WITH clipped AS (
    SELECT d.district_name, d.province,
           ST_AsMVTGeom(ST_Transform(d.%1$I, 3857), $1, 4096, 64, true) AS geom
    FROM geo.districts d WHERE d.%1$I && ST_Transform($1, 4326)
  )
  SELECT ST_AsMVT(clipped, 'districts', 4096, 'geom') FROM clipped WHERE geom IS NOT NULL
$f$, col) INTO result USING bounds;
```

- `&&` against the **4326 column** uses the GiST index. Transforming the column disables it and scans
  the table.
- Buffer 64 stops clipping at tile seams.
- Zoom tier chosen inside, so callers cannot request full resolution at zoom 4.
- Declare `STABLE PARALLEL SAFE`.

Full template in `db/init/02_tile_functions.sql`.

## Scores carry no geometry

`score.*` tables key on `(creation_time, lead_hours, district_name)` and store values only. The old
response embedded polygons and hit 190 MB; the browser already has geometry from tiles.

## Query notes

Use `ST_PointOnSurface`, not `ST_Centroid`, for label points: a centroid of a crescent district lands
outside it and labels a neighbour. Fuzzy name matching uses `%` and `similarity()` against the
trigram index.

## Staging then promote

Repair geometry, assert a minimum row count, `TRUNCATE`, insert, then `geo.rebuild_generalized()` and
`meta.check_integrity()`. The assertion is the point: a source that returned three features should
abort, not replace 167 districts with three. Template in
[ingest-vector-source](../../playbooks/ingest-vector-source.md).

## Tuning

`EXPLAIN (ANALYZE, BUFFERS)`. A `Seq Scan` on a geometry table means the GiST index is unused:
usually a function wrapping the column, a transform on the wrong side, or a missing `ANALYZE` after
bulk load. Always `ANALYZE` after bulk load or the planner works from empty-table statistics.