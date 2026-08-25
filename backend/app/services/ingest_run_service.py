"""Run the PMD ingest and expose its live progress.

The ingest has two triggers, the daily scheduler and the manual "Update data"
control in the header, and both must show the same progress and never overlap.
So this owns a single run at a time: it spawns scripts/ingest/ingest_pmd.py (the
one ingest implementation, shared with the scheduler), reads the @@INGEST progress
lines it prints, and keeps a status object the API serves. A second trigger while
one is running is refused rather than stampeding the portal.

Status is in-process, which is enough because the API is a single process; a
restart resets it to idle, which is honest, the previous run's subprocess is gone
with the process that spawned it.
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone

from app.config import settings
from app.shared.logging import logger

INGEST_SCRIPT = "/app/ingest/ingest_pmd.py"

_lock = asyncio.Lock()
_status: dict = {
    "running": False,
    "reason": None,
    "startedAt": None,
    "finishedAt": None,
    "totalFields": 0,
    "fieldIndex": 0,
    "current": None,
    "totalSteps": None,
    "error": None,
    "configured": None,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def status() -> dict:
    s = dict(_status)
    s["configured"] = settings.pmd_configured
    return s


def _apply(event: dict) -> None:
    """Fold one @@INGEST event into the live status."""
    phase = event.get("phase")
    if phase == "plan":
        _status["totalFields"] = event.get("totalFields", 0)
        _status["fieldIndex"] = 0
        _status["current"] = None
    elif phase == "field":
        _status["fieldIndex"] = event.get("index", _status["fieldIndex"])
        _status["totalFields"] = event.get("totalFields", _status["totalFields"])
        _status["current"] = {
            "model": event.get("model"),
            "modelLabel": event.get("modelLabel"),
            "label": event.get("label"),
            "band": event.get("band"),
            "done": 0,
            "total": event.get("steps", 0),
        }
    elif phase == "step":
        if _status["current"]:
            _status["current"]["done"] = event.get("done", _status["current"]["done"])
            _status["current"]["total"] = event.get("total", _status["current"]["total"])
    elif phase == "done":
        _status["totalSteps"] = event.get("totalSteps")


async def run(reason: str, model: str | None = None) -> None:
    """Run the ingest to completion, updating status as it goes.

    Awaitable, so the scheduler can run it inline; the manual trigger wraps it in a
    task. The lock makes a would-be overlapping run wait rather than double-fetch,
    but callers should check `running` first and refuse instead of queueing.
    """
    if not settings.pmd_configured:
        logger.info("ingest_run_skipped_not_configured", reason=reason)
        return

    async with _lock:
        _status.update({
            "running": True, "reason": reason, "startedAt": _now(), "finishedAt": None,
            "totalFields": 0, "fieldIndex": 0, "current": None, "totalSteps": None, "error": None,
        })
        logger.info("ingest_run_started", reason=reason, model=model or "all")
        args = [sys.executable, INGEST_SCRIPT]
        if model:
            args += ["--model", model]

        tail: list[str] = []
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, cwd="/app",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            assert proc.stdout is not None
            async for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip()
                if line.startswith("@@INGEST "):
                    try:
                        _apply(json.loads(line[len("@@INGEST "):]))
                    except json.JSONDecodeError:
                        pass
                    continue
                if line:
                    tail.append(line)
                    del tail[:-5]
            code = await proc.wait()
        except Exception as exc:  # noqa: BLE001
            _status["error"] = f"{type(exc).__name__}: {exc}"
            logger.exception("ingest_run_spawn_failed", reason=reason)
        else:
            if code != 0:
                _status["error"] = tail[-1] if tail else f"exit {code}"
                logger.error("ingest_run_failed", reason=reason, code=code, tail=tail)
            else:
                logger.info("ingest_run_finished", reason=reason, steps=_status["totalSteps"], tail=tail)
        finally:
            _status["running"] = False
            _status["current"] = None
            _status["finishedAt"] = _now()


def start(reason: str, model: str | None = None) -> bool:
    """Kick off a run in the background. Returns False if one is already running."""
    if _status["running"] or _lock.locked():
        return False
    asyncio.create_task(run(reason, model))
    return True
