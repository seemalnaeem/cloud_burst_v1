"""asyncpg connection pool.

One pool for the process. The DSN comes from the environment and its host is a
compose service name, never an address.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from app.config import settings
from app.shared.logging import logger

_pool: asyncpg.Pool | None = None


async def connect() -> None:
    global _pool
    if _pool is not None:
        return
    _pool = await asyncpg.create_pool(
        dsn=settings.asyncpg_dsn,
        min_size=settings.pg_pool_min,
        max_size=settings.pg_pool_max,
        command_timeout=180,
    )
    logger.info("db_pool_ready", min=settings.pg_pool_min, max=settings.pg_pool_max)


async def disconnect() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool is not connected, call connect() first")
    return _pool


async def fetch(query: str, *args: Any) -> list[asyncpg.Record]:
    async with get_pool().acquire() as conn:
        return await conn.fetch(query, *args)


async def fetchrow(query: str, *args: Any) -> asyncpg.Record | None:
    async with get_pool().acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetchval(query: str, *args: Any) -> Any:
    async with get_pool().acquire() as conn:
        return await conn.fetchval(query, *args)


async def execute(query: str, *args: Any) -> str:
    async with get_pool().acquire() as conn:
        return await conn.execute(query, *args)


async def healthy() -> bool:
    try:
        return await fetchval("SELECT 1") == 1
    except Exception:
        return False
