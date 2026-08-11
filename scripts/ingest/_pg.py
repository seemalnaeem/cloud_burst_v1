"""Postgres access for the ingest scripts.

Every ingest runs inside cbd-api, which carries psql, ogr2ogr and GDAL, and every
one of them needs the same three things: connection settings derived from
DATABASE_URL, a subprocess runner that fails loudly, and a psql wrapper. They
lived in ingest_admin.py until a second script needed them.

No host or port is written down here. DATABASE_URL is the single source, so the
database can move without touching an ingest.
"""

from __future__ import annotations

import os
import subprocess
import sys


def pg_env() -> dict:
    """Connection settings for ogr2ogr and psql, from DATABASE_URL."""
    url = os.environ["DATABASE_URL"].replace("postgresql://", "")
    creds, hostpart = url.split("@", 1)
    user, password = creds.split(":", 1)
    hostport, dbname = hostpart.split("/", 1)
    host, port = hostport.split(":", 1)
    return {
        "PGHOST": host, "PGPORT": port, "PGDATABASE": dbname,
        "PGUSER": user, "PGPASSWORD": password,
    }


def run(cmd: list[str], env: dict | None = None) -> str:
    """Run a command, raising with its own output when it fails.

    capture_output with no reporting on failure is how an ingest ends up
    reporting success having written nothing at all.
    """
    merged = {**os.environ, **(env or {})}
    proc = subprocess.run(cmd, env=merged, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        raise SystemExit(f"Command failed: {' '.join(cmd[:3])}...")
    return proc.stdout


def psql(sql: str, env: dict, quiet: bool = True) -> str:
    args = ["psql", "-v", "ON_ERROR_STOP=1", "-c", sql]
    if quiet:
        args[1:1] = ["-tA"]
    return run(args, env)
