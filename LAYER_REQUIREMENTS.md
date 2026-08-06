# LAYER_REQUIREMENTS.md — what to send from the local catalog

> Hand this to whoever holds the catalog. It lists every layer the portal needs, which are required
> versus optional, and the exact attributes that must survive ingestion.
>
> Shapefiles are fine. So are GeoPackage and GeoJSON. A `.shp` needs its `.shx`, `.dbf`, `.prj` and
> ideally `.cpg` alongside it, otherwise the projection or the encoding is guesswork.

---

## Priority 1, the portal does not work without these

### 1.1 Districts

The single most important layer. `district_name` is the join key linking boundaries to CARI scores,
susceptibility scores and the alert feed. Everything else can arrive later.

| Requirement | Detail |
|---|---|
| Geometry | Polygon or MultiPolygon |
| Expected count | around 167, more is plausible, see the note below |
| Required attributes | district name, province name |
| Wanted if present | division, population, area, any official district code |

The old system's attribute names were `Districts`, `province`, `division`, `Population`. **Send
whatever your catalog actually calls them, do not rename anything to match.** Renaming by hand is
how a mismatch gets hidden. The ingest maps source names to database columns explicitly, and that
mapping is reviewed.

**An official district code, if your catalog has one, is worth more than the name.** A code is
stable across spelling changes and across the district splits Pakistan keeps making. If one exists,
say so and it becomes a second key alongside the name.

### 1.2 Provinces

| Requirement | Detail |
|---|---|
| Geometry | Polygon or MultiPolygon |
| Expected count | 8 |
| Required attributes | province name |

Province drives which CARI threshold matrix a district scores against, so the spelling has to be
consistent with the province field on the district layer. If the two layers spell Khyber Pakhtunkhwa
differently, say so now rather than after ingest.

### 1.3 National boundary

| Requirement | Detail |
|---|---|
| Geometry | Polygon or MultiPolygon |
| Expected count | 1 to 4 |
| Required attributes | name is enough |

Used for clipping rasters and for the map outline. If the catalog has a gap-filled or simplified
version, that one is preferable for clipping.

---

## Priority 2, features degrade without these

### 2.1 Tehsils

| Requirement | Detail |
|---|---|
| Geometry | Polygon or MultiPolygon |
| Expected count | around 554 |
| Required attributes | tehsil name, parent district name |
| Wanted if present | province, area |

Display and drill-down only, no scoring runs at tehsil level today. The parent district name matters
because it is what links a tehsil back to its district's score.

### 2.2 IIOJK districts

| Requirement | Detail |
|---|---|
| Geometry | Polygon or MultiPolygon |
| Expected count | 64 after filtering |
| Required attributes | `ADM2_CODE`, `ADM0_NAME`, `ADM1_NAME` |

The old system used a GAUL schema file where `ADM2_NAME` is blank for the disputed area, so the
numeric `ADM2_CODE` is the key and the district key becomes `IIOJK District <code>`. If your
catalog's version has real names, that is better, tell us and the key changes.

Filtering: keep only `ADM0_NAME = 'Jammu and Kashmir'`. The source file also carries India, Pakistan
and Aksai Chin features. These always score against the terrain matrix.

---

## Priority 3, useful additions

Send these if the catalog has them. None are required, and each unlocks something specific.

| Layer | What it enables |
|---|---|
| **DEM raster** for Pakistan | terrain scoring without downloading Copernicus. See the resolution note below, it matters more than you would expect |
| Historical cloudburst event points | the event markers and detail charts, 21 known events |
| Rivers and streams | flood context on the map |
| Glacial lakes | relevant to cloudburst impact in the north |
| Settlements or populated places | exposure context on alerts |
| Roads | access context for response |
| Land cover | possible future susceptibility input |
| Basins or watersheds | catchment level aggregation |

**On the DEM specifically.** If you have one, tell me its native resolution and its vertical datum.
The old system used 30 m SRTM but did something non-obvious with it that materially changes scores,
described in the findings section of this document. Whichever DEM we use, that behaviour has to be
reproduced deliberately.

---

## What must not change during ingest

These are the rules the ingest follows. They are here so expectations match.

1. **Attribute names are preserved exactly**, original casing and spacing, via `-lco LAUNDER=NO`.
   Several of them are join keys and a silent lowercase breaks scoring with no error.
2. **Everything is reprojected to EPSG:4326** for storage. Send whatever CRS the catalog holds, as
   long as the `.prj` is present so it can be read rather than assumed.
3. **Nothing loads straight into a live table.** Load to staging, validate, promote in a
   transaction with a row count assertion, then generalize.
4. **Invalid geometry is repaired**, not dropped. Self intersections in administrative boundaries
   are common and they make `ST_Intersects` return false with no error, which quietly removes a
   district from every result.

---

## Sending them

Drop the files under `data/raw/`, then for each one:

```bash
docker compose exec cbd-api python3 /app/ingest/ingest_vector.py \
  --file /data/raw/<file>.shp --target districts --dry-run
```

The dry run inspects and reports CRS, feature count, geometry type and every attribute name, and
loads nothing. Send me that output and I will map the attributes and run the real ingest.

Encoding note for shapefiles: if names contain non-ASCII characters and there is no `.cpg` file,
tell me the encoding. The historical events CSV in this project is `latin-1` because a superscript
two in a header broke UTF-8, so this is a live concern here rather than a theoretical one.

---

## The district name reconciliation

This is the part I said I would not guess at, so here is exactly what happens when the file arrives.

**Expect the count to differ from 167.** Pakistan has been creating districts steadily, so a current
catalog legitimately has more. A different count is not automatically wrong, it just means somebody
has to look.

The process, once your file is staged:

1. Diff the incoming names against the previous set. Three buckets come out: exact matches, near
   matches, and names present on only one side.
2. Exact matches need nothing.
3. Near matches get an explicit row in an alias table, reviewed one at a time. The trigram index
   **finds** candidates, it never decides. Fuzzy matching a join key silently is how districts
   vanish from results.
4. Names on one side only are either genuinely new districts, renames, or a district split into two.
   Each needs a decision, and a split needs one about historical scores.
5. Only then does the promote transaction run, followed by `meta.check_integrity()` to confirm no
   score row is orphaned.

I will show you the diff and the proposed aliases before anything is promoted. If your catalog
carries an official district code, most of this disappears, which is why it is worth asking about.
