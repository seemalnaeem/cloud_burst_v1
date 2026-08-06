"""Database access. All queries are parameterized, no string building.

Repository functions return plain dicts. Turning them into response models is
the service layer's job.
"""

from __future__ import annotations

import json
from typing import Any

from app.db import pool
from app.shared.errors import DistrictNotFound


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


async def district_geometry(name: str, generalized: bool = True) -> dict[str, Any]:
    """District geometry as GeoJSON, for zonal statistics.

    Generalized by default. Full resolution is only needed when the raster is
    fine enough for the difference to matter.
    """
    column = "geom_z9" if generalized else "geom"
    row = await pool.fetchrow(
        f"""
        SELECT district_name, province,
               ST_AsGeoJSON(COALESCE({column}, geom))::text AS geometry
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


async def district_extent(name: str) -> dict[str, float] | None:
    row = await pool.fetchrow("SELECT * FROM geo.district_extent($1)", name)
    return dict(row) if row else None


async def latest_cycle() -> dict[str, Any] | None:
    row = await pool.fetchrow(
        """
        SELECT creation_time, model, published_leads
        FROM wx.cycles
        ORDER BY creation_time DESC
        LIMIT 1
        """
    )
    return dict(row) if row else None


async def available_cycles(limit: int = 40) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """
        SELECT creation_time, published_leads
        FROM wx.cycles
        ORDER BY creation_time DESC
        LIMIT $1
        """,
        limit,
    )
    return [dict(r) for r in rows]


async def raster_path(band_key: str, creation_time, lead_hours: int | None) -> str | None:
    """Resolve a band, cycle and lead to a COG path.

    Callers never pass a filesystem path, they pass a band key. That is what
    keeps the raster endpoints from becoming an arbitrary file reader.
    """
    return await pool.fetchval(
        """
        SELECT path FROM wx.raster_catalog
        WHERE band_key = $1
          AND (is_static OR (creation_time = $2 AND lead_hours = $3))
        ORDER BY is_static DESC, created_at DESC
        LIMIT 1
        """,
        band_key,
        creation_time,
        lead_hours,
    )


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
