"""FastAPI application factory.

Listens on 0.0.0.0. Contracts are validated at startup so a malformed threshold
file fails loudly at boot rather than quietly producing wrong scores at request
time.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import pool
from app.routers import alerts, districts, health, meta, raster, score
from app.shared import contracts
from app.shared.errors import AppError
from app.shared.logging import configure_logging, logger


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)

    problems = contracts.validate()
    if problems:
        for p in problems:
            logger.error("contract_invalid", problem=p)
        raise RuntimeError(
            f"{len(problems)} contract problems found, refusing to start. "
            "Fix shared/contracts before continuing."
        )
    logger.info("contracts_loaded")

    await pool.connect()
    logger.info("startup_complete", port=settings.api_port)

    yield

    await pool.disconnect()
    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Convective Activity Risk System API",
        description=(
            "Forecast scoring and geoprocessing service. Thresholds and palettes "
            "come from shared/contracts, never from literals in this code."
        ),
        version="1.0.0",
        lifespan=lifespan,
    )

    # CORS is handled at the gateway, which is the only origin the browser
    # talks to. Adding it here as well would produce duplicate headers, which
    # browsers reject.

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = rid
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        return response

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError):
        rid = getattr(request.state, "request_id", "unknown")
        logger.warning("app_error", code=exc.code, message=exc.message, request_id=rid)
        return JSONResponse(status_code=exc.status, content=exc.envelope(rid))

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception):
        rid = getattr(request.state, "request_id", "unknown")
        # Full detail in the log, generic message in the response. An exception
        # message can carry a connection string.
        logger.exception("unhandled", request_id=rid, path=str(request.url.path))
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL",
                    "message": "Something failed on the server, the request id is in the log.",
                    "requestId": rid,
                }
            },
        )

    app.include_router(health.router, tags=["health"])
    app.include_router(meta.router, prefix="/api/meta", tags=["meta"])
    app.include_router(districts.router, prefix="/api/districts", tags=["districts"])
    app.include_router(score.router, prefix="/api/score", tags=["score"])
    app.include_router(raster.router, prefix="/api/raster", tags=["raster"])
    app.include_router(alerts.router, prefix="/api", tags=["alerts"])

    return app


app = create_app()
