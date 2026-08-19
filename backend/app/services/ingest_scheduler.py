"""Daily forecast ingest scheduler.

The PMD ingest pulls whatever cycle is latest on the portal, but it has always
been run by hand, so the timeline only advances when someone remembers. This runs
it on a daily cadence inside cbd-api: once at a configured UTC hour, and once at
startup if the newest catalogued cycle is not already today's, so a container that
was down across a publish catches up instead of showing a week-old run.

It is deliberately thin. It shells out to the same scripts/ingest/ingest_pmd.py
the manual command runs, inheriting the container environment (DATABASE_URL,
PMD_*), so there is one ingest implementation rather than two. It runs only when
PMD is configured; otherwise it logs once and stays idle, matching the rest of
the stack where an unconfigured source is a no-op, not an error.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone

from app.config import settings
from app.db import repositories
from app.shared.logging import logger

# The ingest script, mounted read-only at /app/ingest in the api container.
INGEST_SCRIPT = "/app/ingest/ingest_pmd.py"
# Back off this long after an unexpected loop error so a persistent failure logs
# hourly rather than spinning.
ERROR_BACKOFF_S = 3600
# Pakistan Standard Time is a fixed UTC+5 with no daylight saving, so the daily
# run fires at the same local hour year round.
PKT = timezone(timedelta(hours=5))

_task: asyncio.Task | None = None
# One ingest at a time within this process: the daily run and the startup
# catch-up must never overlap and stampede the portal.
_running = asyncio.Lock()


async def _newest_cycle_date():
    """The date (UTC) of the newest catalogued cycle, or None if nothing is in."""
    cycle = await repositories.latest_cycle()
    ct = cycle.get("creation_time") if cycle else None
    return ct.astimezone(timezone.utc).date() if ct else None


async def _run_ingest(reason: str) -> None:
    if not settings.pmd_configured:
        logger.info("ingest_skipped_not_configured", reason=reason)
        return
    if _running.locked():
        logger.info("ingest_already_running", reason=reason)
        return

    async with _running:
        args = [sys.executable, INGEST_SCRIPT]
        if settings.ingest_model:
            args += ["--model", settings.ingest_model]
        logger.info("ingest_started", reason=reason, model=settings.ingest_model or "all")
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd="/app",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await proc.communicate()
        except Exception:
            logger.exception("ingest_spawn_failed", reason=reason)
            return

        # Keep the last few lines of the script's own summary out of the log, so a
        # failure shows what it printed without dumping every lead it fetched.
        tail = (out or b"").decode("utf-8", "replace").splitlines()[-3:]
        if proc.returncode == 0:
            logger.info("ingest_finished", reason=reason, tail=tail)
        else:
            logger.error("ingest_failed", reason=reason, code=proc.returncode, tail=tail)


def _seconds_until_next_run(now_utc: datetime) -> float:
    now = now_utc.astimezone(PKT)
    target = now.replace(
        hour=settings.ingest_schedule_hour_pkt, minute=0, second=0, microsecond=0
    )
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _loop() -> None:
    # Catch up on boot if the latest run is stale, then hold to the daily cadence.
    if settings.ingest_catchup_on_start:
        try:
            newest = await _newest_cycle_date()
            today = datetime.now(timezone.utc).date()
            if newest is None or newest < today:
                logger.info("ingest_catchup_due", newest=str(newest), today=str(today))
                await _run_ingest(reason="startup-catchup")
            else:
                logger.info("ingest_catchup_current", newest=str(newest))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("ingest_catchup_failed")

    while True:
        try:
            await asyncio.sleep(_seconds_until_next_run(datetime.now(timezone.utc)))
            await _run_ingest(reason="daily")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("ingest_loop_error")
            await asyncio.sleep(ERROR_BACKOFF_S)


def start() -> None:
    """Spawn the scheduler task, if enabled and PMD is configured."""
    global _task
    if not settings.ingest_schedule_enabled:
        logger.info("ingest_scheduler_disabled")
        return
    if not settings.pmd_configured:
        logger.info("ingest_scheduler_idle_not_configured")
        return
    _task = asyncio.create_task(_loop())
    logger.info("ingest_scheduler_started", hour_pkt=settings.ingest_schedule_hour_pkt)


async def stop() -> None:
    """Cancel the scheduler task on shutdown."""
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    _task = None
