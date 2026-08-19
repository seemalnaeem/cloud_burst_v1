"""asyncpg connection pool.

One pool for the process. The DSN comes from the environment and its host is a
compose service name, never an address.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import asyncpg

from app.config import settings
from app.shared.logging import logger

_pool: asyncpg.Pool | None = None

# How long to keep trying the database at startup, and the gap between tries. A
# machine reboot restarts every container at once, and Docker's restart policy
# does not honour depends_on ordering, so the api can come up while Postgres is
# still initialising. Rather than fail startup and sit dead until a manual
# restart, wait out that window; a database that is genuinely down still fails
# loudly once the window elapses.
_CONNECT_TIMEOUT_S = 90
_CONNECT_RETRY_S = 2


async def connect() -> None:
    global _pool
    if _pool is not None:
        return
    deadline = time.monotonic() + _CONNECT_TIMEOUT_S
    attempt = 0
    while True:
        attempt += 1
        try:
            _pool = await asyncpg.create_pool(
                dsn=settings.asyncpg_dsn,
                min_size=settings.pg_pool_min,
                max_size=settings.pg_pool_max,
                command_timeout=180,
            )
            break
        except (asyncpg.CannotConnectNowError, OSError) as exc:
            # CannotConnectNowError is "the database system is starting up";
            # OSError covers connection refused and the service name not yet
            # resolving. Both are transient during a co-ordinated restart.
            if time.monotonic() >= deadline:
                logger.error("db_pool_unreachable", attempts=attempt, error=str(exc))
                raise
            logger.warning("db_pool_waiting", attempt=attempt, error=str(exc))
            await asyncio.sleep(_CONNECT_RETRY_S)
    logger.info("db_pool_ready", min=settings.pg_pool_min, max=settings.pg_pool_max, attempts=attempt)


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


async def executemany(query: str, args: list[tuple]) -> None:
    """Run one statement against many argument tuples on a single connection.

    Used to pre-warm the per feature score caches at the end of a choropleth
    pass, so hundreds of upserts share one connection rather than one each.
    """
    if not args:
        return
    async with get_pool().acquire() as conn:
        await conn.executemany(query, args)


async def healthy() -> bool:
    try:
        return await fetchval("SELECT 1") == 1
    except Exception:
        return False
