"""Liveness and readiness."""

from __future__ import annotations

import shutil

from fastapi import APIRouter

from app.config import settings
from app.db import pool, repositories
from app.shared import contracts

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    """Liveness. Cheap enough for a Docker healthcheck every fifteen seconds."""
    return {"status": "ok", "service": "cbd-api", "port": settings.api_port}


@router.get("/ready")
async def ready() -> dict:
    """Readiness. Confirms the things that fail quietly.

    Contracts loaded, database reachable, GDAL binaries present, COG directory
    mounted. A missing /shared mount is the single most common local setup
    failure and it produces confusing errors much later.
    """
    db_ok = await pool.healthy()
    contract_problems = contracts.validate()

    tools = {
        name: shutil.which(name) is not None
        for name in ("gdalinfo", "ogr2ogr", "gdal_translate", "gdalwarp", "gdaldem", "rio")
    }

    checks = {
        "database": db_ok,
        "contracts": not contract_problems,
        "cog_dir": settings.cog_dir.exists(),
        "raw_dir": settings.raw_dir.exists(),
        "gdal_tools": all(tools.values()),
    }

    return {
        "status": "ok" if all(checks.values()) else "degraded",
        "checks": checks,
        "tools": tools,
        "contractProblems": contract_problems,
    }


@router.get("/integrity")
async def integrity() -> dict:
    """Post ingest data checks.

    Run after any boundary load. An orphaned score row means the join key
    changed, which otherwise fails silently by making districts vanish from
    results with no error anywhere.
    """
    report = await repositories.integrity_report()
    failed = [r for r in report if r["status"] == "fail"]
    return {"status": "fail" if failed else "ok", "checks": report}
