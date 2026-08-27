"""Database access. All queries are parameterized, no string building.

Repository functions return plain dicts. Turning them into response models is
the service layer's job.
"""

from __future__ import annotations

import json
from typing import Any

from app.db import pool
from app.shared import contracts
from app.shared.errors import DistrictNotFound


def _max_stale_hours() -> int:
    """The ceiling on how old a fallback cycle may be, from the resilience
    contract. Beyond it a cycle is not served as a stand-in for fresh data."""
    return int(contracts.load("resilience")["maxStaleHours"])


async def list_districts(province: str | None = None) -> list[dict[str, Any]]:
    if province:
        rows = await pool.fetch(
            """
            SELECT district_name, province, division, population
            FROM geo.districts
            WHERE province = $1
            ORDER BY district_name
            """,
            province,
        )
    else:
        rows = await pool.fetch(
            """
            SELECT district_name, province, division, population
            FROM geo.districts
            ORDER BY district_name
            """
        )
    return [dict(r) for r in rows]


async def suggest(name: str, limit: int = 5) -> list[str]:
    """Closest district names. Powers the hint on a 404."""
    rows = await pool.fetch("SELECT district_name FROM geo.suggest_district($1, $2)", name, limit)
    return [r["district_name"] for r in rows]


async def get_district(name: str) -> dict[str, Any]:
    """One district with its attributes.

    Raises with suggestions rather than returning None, because an unknown
    district is almost always a spelling difference in a join key and the
    suggestion saves a round trip.
    """
    row = await pool.fetchrow(
        """
        SELECT district_name, province, division, country, population
        FROM geo.districts
        WHERE district_name = $1
        """,
        name,
    )
    if row is None:
        raise DistrictNotFound(name, await suggest(name))
    return dict(row)


async def district_geometry(name: str, tolerance_deg: float | None = None) -> dict[str, Any]:
    """District geometry as GeoJSON, for zonal statistics.

    Full resolution by default. The stored generalized columns are gone: they
    were built at a fixed 0.05 degrees, which reduced the district layer from
    6.7 million vertices to 2,899 and made every boundary visibly blocky. Tiles
    now thin to their own zoom instead, and there is nothing left to read here.

    Pass a tolerance only when the raster is coarse enough that the difference
    cannot matter. Simplifying a district for a 30 m DEM moves the boundary
    further than the pixels it is supposed to select.
    """
    geometry = "geom" if tolerance_deg is None else f"ST_SimplifyPreserveTopology(geom, {float(tolerance_deg)})"
    row = await pool.fetchrow(
        f"""
        SELECT district_name, province,
               ST_AsGeoJSON({geometry})::text AS geometry
        FROM geo.districts
        WHERE district_name = $1
        """,
        name,
    )
    if row is None:
        raise DistrictNotFound(name, await suggest(name))
    return {
        "district_name": row["district_name"],
        "province": row["province"],
        "geometry": json.loads(row["geometry"]),
    }


async def list_district_geometries(tolerance_deg: float) -> list[dict[str, Any]]:
    """Every district with simplified geometry, in one query.

    The whole-layer scorer needs all boundaries at once; fetching them per
    feature is 188 round trips. This returns them together, simplified to the
    same tolerance the choropleth uses, geometry already parsed to a dict.
    """
    rows = await pool.fetch(
        f"""
        SELECT district_name, province,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, {float(tolerance_deg)}))::text AS geometry
        FROM geo.districts
        ORDER BY district_name
        """
    )
    return [
        {"district_name": r["district_name"], "province": r["province"],
         "geometry": json.loads(r["geometry"])}
        for r in rows
    ]


async def list_tehsil_geometries(tolerance_deg: float) -> list[dict[str, Any]]:
    """Every tehsil with simplified geometry, in one query.

    The tehsil analog of list_district_geometries, keyed on tehsil_code with the
    parent district as district_src so the scorer can pick the terrain matrix.
    """
    rows = await pool.fetch(
        f"""
        SELECT tehsil_code, tehsil, province, district_src,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, {float(tolerance_deg)}))::text AS geometry
        FROM geo.tehsils
        ORDER BY tehsil_code
        """
    )
    return [
        {"tehsil_code": r["tehsil_code"], "tehsil": r["tehsil"], "province": r["province"],
         "district_src": r["district_src"], "geometry": json.loads(r["geometry"])}
        for r in rows
    ]


async def cached_choropleth_leads(feature_kind: str, creation_time) -> set[int]:
    """Which leads already have a cached choropleth for this kind and cycle.

    One query behind the timeline warm-up progress, so a poll reports how much of
    the slider is ready without probing each lead separately.
    """
    rows = await pool.fetch(
        """
        SELECT lead_hours FROM score.cari_choropleth
        WHERE feature_kind = $1 AND creation_time = $2
        """,
        feature_kind,
        creation_time,
    )
    return {r["lead_hours"] for r in rows}


async def district_extent(name: str) -> dict[str, float] | None:
    row = await pool.fetchrow("SELECT * FROM geo.district_extent($1)", name)
    return dict(row) if row else None


async def list_tehsils() -> list[dict[str, Any]]:
    """Every tehsil with what CARI needs to score it.

    tehsil_code is the join key the choropleth colours by, because tehsil names
    repeat across districts. province and district_src pick the threshold matrix,
    the same rule districts use, applied to the tehsil's parent district.
    """
    rows = await pool.fetch(
        """
        SELECT tehsil_code, tehsil, province, district_src
        FROM geo.tehsils
        ORDER BY tehsil_code
        """
    )
    return [dict(r) for r in rows]


async def tehsil_geometry(tehsil_code: str, tolerance_deg: float | None = None) -> dict[str, Any]:
    """Tehsil geometry as GeoJSON, for zonal statistics.

    Keyed on tehsil_code, the unique identifier; the human name is not unique.
    The parent district comes back as district_src so the caller can pick the
    same terrain matrix a district would.
    """
    geometry = "geom" if tolerance_deg is None else f"ST_SimplifyPreserveTopology(geom, {float(tolerance_deg)})"
    row = await pool.fetchrow(
        f"""
        SELECT tehsil_code, tehsil, province, district_src,
               ST_AsGeoJSON({geometry})::text AS geometry
        FROM geo.tehsils
        WHERE tehsil_code = $1
        """,
        tehsil_code,
    )
    if row is None:
        raise DistrictNotFound(tehsil_code, [])
    return {
        "tehsil_code": row["tehsil_code"],
        "tehsil": row["tehsil"],
        "province": row["province"],
        "district_src": row["district_src"],
        "geometry": json.loads(row["geometry"]),
    }


async def region_geometry(kind: str, key: str, tolerance_deg: float | None = 0.01) -> dict[str, Any] | None:
    """Geometry for a district, tehsil or IIOJK district, for the forecast chart.

    A district is keyed by district_name, a tehsil by tehsil_code, and an IIOJK
    district by district_code within province IJK. Simplified a touch by default,
    which is harmless against the coarse forecast grids the series reduces over and
    keeps the zonal clip quick.
    """
    geom = "geom" if tolerance_deg is None else f"ST_SimplifyPreserveTopology(geom, {float(tolerance_deg)})"
    if kind == "tehsil":
        sql = f"SELECT tehsil AS name, ST_AsGeoJSON({geom})::text AS g FROM geo.tehsils WHERE tehsil_code = $1"
    elif kind == "iiojk":
        sql = f"SELECT district_name AS name, ST_AsGeoJSON({geom})::text AS g FROM geo.districts WHERE district_code = $1 AND province_code = 'IJK'"
    else:
        sql = f"SELECT district_name AS name, ST_AsGeoJSON({geom})::text AS g FROM geo.districts WHERE district_name = $1"
    row = await pool.fetchrow(sql, key)
    if row is None:
        return None
    return {"name": row["name"], "geometry": json.loads(row["g"])}


# A fixed allowlist of layer id to source, so the extent query never interpolates
# anything a caller supplied. This is the "map a dynamic table name through a
# fixed allowlist" rule from the security guardrail made concrete. A tuple is
# (table, where). Everything not listed is a raster, and every raster the portal
# serves is clipped to the national boundary, so its extent is the nation's.
_LAYER_EXTENT_SOURCE: dict[str, object] = {
    "pak_national": "geo.national",
    "pak_provinces": "geo.provinces",
    "pak_districts": "geo.districts",
    "pak_tehsils": "geo.tehsils",
    "iiojk_districts": ("geo.districts", "province_code = 'IJK'"),
    "historic_events": "obs.events",
}


async def layer_extent(layer_id: str) -> dict[str, float] | None:
    """Bounding box of a layer's geometry, in EPSG:4326.

    Returns None when the layer has no rows yet, which is a real state for the
    events layer, so the caller can fall back rather than fly to an empty box.
    """
    spec = _LAYER_EXTENT_SOURCE.get(layer_id, "geo.national")
    table, where = spec if isinstance(spec, tuple) else (spec, None)
    clause = f" WHERE {where}" if where else ""

    row = await pool.fetchrow(
        f"""
        SELECT ST_XMin(e) AS west, ST_YMin(e) AS south,
               ST_XMax(e) AS east, ST_YMax(e) AS north
        FROM (SELECT ST_Extent(geom) AS e FROM {table}{clause}) s
        """
    )
    if not row or row["west"] is None:
        return None
    return {"west": row["west"], "south": row["south"], "east": row["east"], "north": row["north"]}


async def province_extent(province: str) -> dict[str, float] | None:
    """Bounding box of every district in a province, in EPSG:4326.

    Drives the High-Alert stepper's fly-to: geo.districts carries all six alert
    provinces (Azad Kashmir and Gilgit Baltistan included), so the extent is taken
    from it rather than geo.provinces. Returns None for an unknown province name.
    """
    row = await pool.fetchrow(
        """
        SELECT ST_XMin(e) AS west, ST_YMin(e) AS south,
               ST_XMax(e) AS east, ST_YMax(e) AS north
        FROM (SELECT ST_Extent(geom) AS e FROM geo.districts WHERE province = $1) s
        """,
        province,
    )
    if not row or row["west"] is None:
        return None
    return {"west": row["west"], "south": row["south"], "east": row["east"], "north": row["north"]}


async def districts_for_matrix(tolerance_deg: float = 0.005) -> list[dict[str, Any]]:
    """Every district as (name, province, geometry), for the terrain matrix raster.

    The per pixel CAR Index picks the terrain or lowlands thresholds cell by cell,
    the same choice terrain_class makes per district, so the generator needs each
    district's province and geometry to burn that choice onto the grid. Simplified
    a touch by default: the mask is rasterized to a roughly 5 km grid, so a
    hundredth-of-a-degree of boundary detail cannot land in a different cell, and
    dropping the full 6.7-million-vertex resolution keeps the rasterization quick.
    """
    rows = await pool.fetch(
        f"""
        SELECT district_name, province,
               ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, {float(tolerance_deg)}))::text AS geometry
        FROM geo.districts
        """
    )
    return [
        {"district_name": r["district_name"], "province": r["province"], "geometry": json.loads(r["geometry"])}
        for r in rows
    ]


async def catalog_computed_raster(
    band_key: str,
    model: str,
    creation_time,
    lead_hours: int,
    path: str,
    *,
    unit: str | None,
    min_value: float | None,
    max_value: float | None,
    nodata: float | None,
) -> None:
    """Register a generated COG so the tile route can resolve it.

    Computed rasters (the per pixel CAR Index, the hotspot mask) are catalogued
    against the WRFPRS cycle and lead they were generated for, under the WRFPRS
    model, which is what the foreign key onto wx.cycles requires and what lets the
    same resolve path that serves an ingested band serve these too. Replace rather
    than upsert: the unique index is over an expression, so a delete then insert is
    both simpler and correct when a lead is regenerated.
    """
    async with pool.get_pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                DELETE FROM wx.raster_catalog
                WHERE band_key = $1 AND model = $2 AND creation_time = $3 AND lead_hours = $4
                """,
                band_key, model, creation_time, lead_hours,
            )
            await conn.execute(
                """
                INSERT INTO wx.raster_catalog
                  (band_key, model, creation_time, lead_hours, path, unit,
                   min_value, max_value, nodata, is_static)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
                """,
                band_key, model, creation_time, lead_hours, path, unit,
                min_value, max_value, nodata,
            )


async def latest_cycle(model: str | None = None) -> dict[str, Any] | None:
    """The cycle a reader should serve, for one model or across all of them.

    Not simply the newest by time. A run that failed or was interrupted can leave a
    newest-but-incomplete cycle, and serving it would blank the layers it never got
    to. So the preference is: the newest COMPLETE cycle within the staleness cap; if
    none is complete (e.g. straight after a fresh install, or every recent run was
    partial) the newest cycle within the cap, so partial data still beats none; and
    nothing at all past the cap, so a reader shows its not-available state rather
    than misleadingly old weather.

    The returned dict carries `complete` and `stale` so the API can tell the client
    it is looking at a fallback and how old it is. A model is passed for a forecast
    layer, because two models publish a cycle at the same hour and the layer must
    scrub its own model's run. No model is the fallback for "is anything ingested".
    """
    cap = _max_stale_hours()
    where_model = "AND model = $1" if model else ""
    args = [model] if model else []
    # ORDER BY complete first so a complete cycle wins over a newer partial one,
    # then by time; the cap keeps a very old run from standing in silently.
    row = await pool.fetchrow(
        f"""
        SELECT creation_time, model, published_leads, complete
        FROM wx.cycles
        WHERE creation_time >= now() - make_interval(hours => {cap}) {where_model}
        ORDER BY complete DESC, creation_time DESC
        LIMIT 1
        """,
        *args,
    )
    if not row:
        return None
    out = dict(row)
    newest = await pool.fetchrow(
        f"SELECT creation_time FROM wx.cycles WHERE true {where_model} "
        "ORDER BY creation_time DESC LIMIT 1",
        *args,
    )
    # Stale when the served cycle is not the absolute newest run (we stepped back to
    # a complete one), so the client can flag it. Age-based labelling is layered on
    # top in the service from staleNoticeHours.
    out["stale"] = bool(newest and newest["creation_time"] != out["creation_time"])
    return out


async def cycle_for_band(band_key: str, model: str | None, lead_hours: int | None) -> Any | None:
    """The creation_time of the best cycle that actually holds this band and lead.

    Cycle selection is per model, but a partial newest-complete cycle can be missing
    an individual band that an older cycle still has. Rather than blank that one
    layer, resolve it against the newest cycle (complete preferred) within the cap
    that carries it. Returns None when no cycle in the window has it.
    """
    cap = _max_stale_hours()
    return await pool.fetchval(
        f"""
        SELECT rc.creation_time
        FROM wx.raster_catalog rc
        JOIN wx.cycles cy ON cy.model = rc.model AND cy.creation_time = rc.creation_time
        WHERE rc.band_key = $1 AND rc.model = $2 AND rc.lead_hours = $3
          AND rc.creation_time >= now() - make_interval(hours => {cap})
        ORDER BY cy.complete DESC, rc.creation_time DESC
        LIMIT 1
        """,
        band_key,
        model,
        lead_hours,
    )


async def last_ingest_time() -> Any | None:
    """When a cycle was most recently registered, in wall-clock time.

    discovered_at is stamped on every successful ingest of a cycle, not only the
    first, so its maximum is the honest "data last refreshed" moment. It survives an
    API restart, unlike the in-process run status, which is why the header's
    freshness guard reads it rather than the last run's finish time.
    """
    return await pool.fetchval("SELECT MAX(discovered_at) FROM wx.cycles")


async def forecast_models() -> list[dict[str, Any]]:
    """The serving cycle per model, for the model selector and per-model timeline.

    One row per model, the cycle a reader should serve and the leads it published.
    Same preference as latest_cycle: newest complete within the staleness cap wins
    over a newer partial one, so the slider draws a finished run's leads rather than
    a half-written run's. The panel offers exactly these models.
    """
    cap = _max_stale_hours()
    rows = await pool.fetch(
        f"""
        SELECT DISTINCT ON (model) model, creation_time, published_leads, complete, discovered_at
        FROM wx.cycles
        WHERE creation_time >= now() - make_interval(hours => {cap})
        ORDER BY model, complete DESC, creation_time DESC
        """
    )
    return [dict(r) for r in rows]


async def available_cycles(model: str, limit: int = 40) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """
        SELECT creation_time, published_leads
        FROM wx.cycles
        WHERE model = $1
        ORDER BY creation_time DESC
        LIMIT $2
        """,
        model,
        limit,
    )
    return [dict(r) for r in rows]


async def catalogued_leads(band_key: str, model: str | None, creation_time) -> list[int]:
    """The lead hours a band is catalogued at, for one model and cycle.

    Used by the nearest-lead fallback: a field the source leaves empty at some
    leads (GRAPES precipitable water at the synoptic steps) is scored from the
    closest lead that has data, and this is how the scorer learns which leads
    that band actually offers.
    """
    rows = await pool.fetch(
        """
        SELECT lead_hours FROM wx.raster_catalog
        WHERE band_key = $1 AND model = $2 AND creation_time = $3
              AND lead_hours IS NOT NULL
        ORDER BY lead_hours
        """,
        band_key,
        model,
        creation_time,
    )
    return [r["lead_hours"] for r in rows]


async def raster_path(band_key: str, model: str | None, creation_time, lead_hours: int | None) -> str | None:
    """Resolve a band, model, cycle and lead to a COG path.

    Callers never pass a filesystem path, they pass a band key and a model. That
    is what keeps the raster endpoints from becoming an arbitrary file reader. A
    static band ignores the model and cycle; a forecast band needs both, because
    the same band exists under several models.
    """
    return await pool.fetchval(
        """
        SELECT path FROM wx.raster_catalog
        WHERE band_key = $1
          AND (is_static OR (model = $2 AND creation_time = $3 AND lead_hours = $4))
        ORDER BY is_static DESC, created_at DESC
        LIMIT 1
        """,
        band_key,
        model,
        creation_time,
        lead_hours,
    )


async def catalogued_bands() -> list[dict[str, Any]]:
    """Which bands can currently resolve to a raster, per model, and how many.

    Static bands resolve on their own and carry a NULL model. Cycle driven bands
    need a cycle as well, so `cycles` being zero is the difference between
    "ingested" and "ingested for a forecast run that exists". The model is
    returned because the same band under two models is two different answers, and
    the panel enables a row only when its own (band, model) pair is present.
    """
    rows = await pool.fetch(
        """
        SELECT band_key,
               model,
               bool_or(is_static)                              AS is_static,
               count(*)                                        AS entries,
               count(DISTINCT creation_time)                   AS cycles,
               max(created_at)                                 AS ingested_at
        FROM wx.raster_catalog
        GROUP BY band_key, model
        ORDER BY band_key, model
        """
    )
    return [dict(r) for r in rows]


async def cached_cari(creation_time, lead_hours: int, district: str, matrix: str):
    row = await pool.fetchrow(
        """
        SELECT scores, cas, cari, class_idx, override_applied, matrix
        FROM score.cari
        WHERE creation_time = $1 AND lead_hours = $2
          AND district_name = $3 AND matrix = $4
        """,
        creation_time,
        lead_hours,
        district,
        matrix,
    )
    return dict(row) if row else None


async def store_cari(creation_time, lead_hours: int, district: str, result) -> None:
    await pool.execute(
        """
        INSERT INTO score.cari (creation_time, lead_hours, district_name, matrix,
                                scores, cas, cari, class_idx, override_applied)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        ON CONFLICT (creation_time, lead_hours, district_name, matrix)
        DO UPDATE SET scores = EXCLUDED.scores, cas = EXCLUDED.cas,
                      cari = EXCLUDED.cari, class_idx = EXCLUDED.class_idx,
                      override_applied = EXCLUDED.override_applied,
                      computed_at = now()
        """,
        creation_time,
        lead_hours,
        district,
        result.matrix,
        json.dumps(result.scores),
        result.cas,
        result.cari,
        result.class_idx,
        result.override_applied,
    )


async def cached_cari_tehsil(creation_time, lead_hours: int, tehsil_code: str):
    """The cached full CARI for one tehsil, or None.

    The tehsil cache is written only by the whole-layer choropleth pass, which
    always scores under the automatic terrain matrix, so at most one row exists
    per cycle and lead and a lookup by code alone is unambiguous.
    """
    row = await pool.fetchrow(
        """
        SELECT scores, cas, cari, class_idx, override_applied, matrix
        FROM score.cari_tehsil
        WHERE creation_time = $1 AND lead_hours = $2 AND tehsil_code = $3
        """,
        creation_time,
        lead_hours,
        tehsil_code,
    )
    return dict(row) if row else None


async def store_cari_batch(creation_time, lead_hours: int, rows: list[tuple]) -> None:
    """Pre-warm the district detail-card cache for a whole layer at once.

    rows is a list of (district_name, result). Called at the end of the district
    choropleth pass so a click on any coloured district reads score.cari instead
    of rescoring 13 rasters. The upsert matches store_cari exactly.
    """
    await pool.executemany(
        """
        INSERT INTO score.cari (creation_time, lead_hours, district_name, matrix,
                                scores, cas, cari, class_idx, override_applied)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        ON CONFLICT (creation_time, lead_hours, district_name, matrix)
        DO UPDATE SET scores = EXCLUDED.scores, cas = EXCLUDED.cas,
                      cari = EXCLUDED.cari, class_idx = EXCLUDED.class_idx,
                      override_applied = EXCLUDED.override_applied,
                      computed_at = now()
        """,
        [
            (creation_time, lead_hours, name, r.matrix, json.dumps(r.scores),
             r.cas, r.cari, r.class_idx, r.override_applied)
            for name, r in rows
        ],
    )


async def store_cari_tehsil_batch(creation_time, lead_hours: int, rows: list[tuple]) -> None:
    """Pre-warm the tehsil detail-card cache for a whole layer at once.

    rows is a list of (tehsil_code, result). Mirrors store_cari_batch for the
    tehsil layer, populating score.cari_tehsil from the choropleth pass so a
    tehsil click is one indexed read.
    """
    await pool.executemany(
        """
        INSERT INTO score.cari_tehsil (creation_time, lead_hours, tehsil_code, matrix,
                                       scores, cas, cari, class_idx, override_applied)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        ON CONFLICT (creation_time, lead_hours, tehsil_code, matrix)
        DO UPDATE SET scores = EXCLUDED.scores, cas = EXCLUDED.cas,
                      cari = EXCLUDED.cari, class_idx = EXCLUDED.class_idx,
                      override_applied = EXCLUDED.override_applied,
                      computed_at = now()
        """,
        [
            (creation_time, lead_hours, code, r.matrix, json.dumps(r.scores),
             r.cas, r.cari, r.class_idx, r.override_applied)
            for code, r in rows
        ],
    )


async def cached_choropleth(feature_kind: str, creation_time, lead_hours: int) -> dict | None:
    """The cached class array for a whole layer, or None if it has not been built.

    The pool registers no jsonb codec, so a jsonb column comes back as text and
    the payload is parsed here rather than handed on as a string.
    """
    row = await pool.fetchrow(
        """
        SELECT payload, feature_count, computed_at
        FROM score.cari_choropleth
        WHERE feature_kind = $1 AND creation_time = $2 AND lead_hours = $3
        """,
        feature_kind,
        creation_time,
        lead_hours,
    )
    if row is None:
        return None
    out = dict(row)
    if isinstance(out["payload"], str):
        out["payload"] = json.loads(out["payload"])
    return out


async def store_choropleth(
    feature_kind: str, creation_time, lead_hours: int, payload: list[dict]
) -> None:
    await pool.execute(
        """
        INSERT INTO score.cari_choropleth
            (feature_kind, creation_time, lead_hours, payload, feature_count)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        ON CONFLICT (feature_kind, creation_time, lead_hours)
        DO UPDATE SET payload = EXCLUDED.payload,
                      feature_count = EXCLUDED.feature_count,
                      computed_at = now()
        """,
        feature_kind,
        creation_time,
        lead_hours,
        json.dumps(payload),
        len(payload),
    )


async def alerts_for(target_date) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """
        SELECT district_name, province, class_idx, risk_level, risk_color, cari,
               creation_time, lead_hours, generated_at
        FROM score.alerts
        WHERE target_date = $1
        ORDER BY class_idx DESC, district_name
        """,
        target_date,
    )
    return [dict(r) for r in rows]


async def integrity_report() -> list[dict[str, Any]]:
    rows = await pool.fetch("SELECT * FROM meta.check_integrity()")
    return [dict(r) for r in rows]


# ----------------------------------------------------------------- historic events


async def list_events() -> list[dict[str, Any]]:
    """Every event, lightly: id, name, date and coordinates.

    The map draws the points from vector tiles; this is for a caller that wants
    the list without the tiles, and it stays small by leaving the images out.
    """
    rows = await pool.fetch(
        """
        SELECT id, sr_no, location_name, occurrence, district_name,
               ST_Y(geom) AS latitude, ST_X(geom) AS longitude
        FROM obs.events
        ORDER BY sr_no NULLS LAST, id
        """
    )
    return [dict(r) for r in rows]


async def events_geojson() -> dict[str, Any]:
    """Every event as a GeoJSON FeatureCollection, geometry from ST_AsGeoJSON.

    Points are drawn from this rather than from vector tiles, by exception: the
    set is tiny, so a client side geojson source renders every marker at every
    zoom with no tiling. The feature id is set to the row id so Mapbox feature
    state (hover, selection) works and the detail card can score by it.
    """
    row = await pool.fetchval(
        """
        SELECT json_build_object(
          'type', 'FeatureCollection',
          'features', COALESCE(json_agg(
            json_build_object(
              'type', 'Feature',
              'id', id,
              'geometry', ST_AsGeoJSON(geom)::json,
              'properties', json_build_object(
                'id', id,
                'location_name', location_name,
                'occurrence', occurrence,
                'district_name', district_name,
                'rainfall_mm', rainfall_mm,
                'cape_j_kg', cape_j_kg,
                'elevation_m', elevation_m,
                'slope_deg', slope_deg
              )
            )
          ), '[]'::json)
        )::text
        FROM obs.events
        """
    )
    return json.loads(row)


async def get_event(event_id: int) -> dict[str, Any] | None:
    """One event with its physical values, coordinates and photo manifest.

    The photos come back as metadata only, ordered by seq. The bytes are fetched
    one at a time through event_photo, so opening the card is one small JSON read
    and the images stream in as the carousel needs them.
    """
    row = await pool.fetchrow(
        """
        SELECT id, sr_no, location_name, occurrence, occurred_on, district_name,
               rainfall_mm, cape_j_kg, relative_humidity_pct, precipitable_water_mm,
               vertical_velocity, elevation_m, slope_deg,
               ST_Y(geom) AS latitude, ST_X(geom) AS longitude
        FROM obs.events
        WHERE id = $1
        """,
        event_id,
    )
    if row is None:
        return None
    photos = await pool.fetch(
        """
        SELECT seq, filename, mime, width, height, byte_size
        FROM obs.event_photos
        WHERE event_id = $1
        ORDER BY seq
        """,
        event_id,
    )
    out = dict(row)
    out["photos"] = [dict(p) for p in photos]
    return out


async def event_photo(event_id: int, seq: int) -> dict[str, Any] | None:
    """The bytes and content type of one image, for the image endpoint."""
    row = await pool.fetchrow(
        """
        SELECT image, mime, byte_size
        FROM obs.event_photos
        WHERE event_id = $1 AND seq = $2
        """,
        event_id,
        seq,
    )
    return dict(row) if row else None
