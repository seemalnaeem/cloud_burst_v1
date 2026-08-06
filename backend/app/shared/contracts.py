"""Loader for shared/contracts.

Every threshold, weight, class boundary and palette comes from here. Nothing in
this project retypes one of those numbers into Python. The one exception is the
validation below, which exists to catch a malformed contract at startup rather
than three layers down inside a scoring loop.

See .claude/guardrails/data-contracts.md for why.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import settings


def _strip_comments(node: Any) -> Any:
    """Drop the $-prefixed keys. JSON has no comments so the contracts use
    keys like $comment to carry the explanation, and callers should never see
    them."""
    if isinstance(node, dict):
        return {k: _strip_comments(v) for k, v in node.items() if not k.startswith("$")}
    if isinstance(node, list):
        return [_strip_comments(v) for v in node]
    return node


@lru_cache
def _load_cached(name: str, mtime_ns: int) -> dict:  # noqa: ARG001
    """Parse and cache one contract. mtime_ns is part of the cache key on
    purpose: editing the file changes the key, so the next call reparses."""
    path: Path = settings.contracts_dir / f"{name}.json"
    with path.open(encoding="utf-8") as fh:
        return _strip_comments(json.load(fh))


def load(name: str) -> dict:
    """Read a contract, reparsing it whenever the file on disk has changed.

    An earlier version cached purely on the name. That is correct in production,
    where the files never change under a running process, and quietly wrong in
    development, where ./shared is bind mounted: editing a contract had no
    effect until the container restarted. It cost an afternoon. The frontend was
    handed a stale basemap catalogue, built style URLs in the previous format,
    and rendered a blank map with no error anywhere, because every layer of the
    stack was behaving exactly as designed on data that was simply old.

    A stat per call is cheap next to the JSON parse this is still avoiding.
    """
    path: Path = settings.contracts_dir / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Contract {name}.json not found at {path}. "
            "Is ./shared mounted into the container?"
        )
    return _load_cached(name, path.stat().st_mtime_ns)


# Eagerly named accessors, so a typo is an AttributeError at import rather than
# a KeyError somewhere deep in a request.
def cari() -> dict:
    return load("cari")


def hotspot() -> dict:
    return load("hotspot")


def susceptibility() -> dict:
    return load("susceptibility")


def bands() -> dict:
    return load("bands")


def palettes() -> dict:
    return load("palettes")


def layers() -> dict:
    return load("layers")


def basemaps() -> dict:
    return load("basemaps")


def time_model() -> dict:
    return load("time")


def band(key: str) -> dict:
    """One band by key. Raises rather than returning None, because a missing
    band always means a typo or a contract that was not updated."""
    for entry in bands()["bands"]:
        if entry["key"] == key:
            return entry
    raise KeyError(f"Band {key!r} is not in bands.json")


def validate() -> list[str]:
    """Shape checks run at startup. Returns a list of problems, empty means ok.

    These are the invariants worth asserting because breaking one of them
    produces wrong numbers rather than an exception.
    """
    problems: list[str] = []

    c = cari()
    variables = c["variables"]
    keys = [v["key"] for v in variables]

    if len(keys) != len(set(keys)):
        problems.append("cari.json has duplicate variable keys")

    primary = [v for v in variables if v["tier"] == "primary"]
    secondary = [v for v in variables if v["tier"] == "secondary"]
    expected_max = (
        len(primary) * 6 * c["weights"]["primary"]
        + len(secondary) * 6 * c["weights"]["secondary"]
    )
    if abs(expected_max - c["casMax"]) > 1e-9:
        problems.append(
            f"cari.json casMax is {c['casMax']} but the weights and variable "
            f"counts imply {expected_max}"
        )

    for matrix_name, matrix in c["matrices"].items():
        thresholds = matrix["thresholds"]
        missing = set(keys) - set(thresholds)
        if missing:
            problems.append(f"cari matrix {matrix_name} is missing thresholds for {sorted(missing)}")
        for key, values in thresholds.items():
            if len(values) != 6:
                problems.append(
                    f"cari matrix {matrix_name} threshold {key} has {len(values)} entries, expected 6"
                )

    classes = c["classes"]
    if [cl["idx"] for cl in classes] != list(range(len(classes))):
        problems.append("cari.json classes are not indexed 0..n contiguously")

    # Terrain reduction. Slope must be derived from the 5 km DEM rather than
    # the native one, because slope over a 5 km run is far gentler and both
    # boolean models test it at 15 degrees. Getting this wrong inflates every
    # mountain district without raising anything.
    reduction = c.get("terrainReduction")
    if not reduction:
        problems.append("cari.json is missing terrainReduction")
    else:
        steps = reduction.get("scalarPath", {}).get("steps", [])
        slope_steps = [s for s in steps if s.get("op") == "slope"]
        if len(slope_steps) != 1:
            problems.append("cari.json terrainReduction needs exactly one slope step")
        elif slope_steps[0].get("source") != "dem@5000":
            problems.append(
                "cari.json terrainReduction derives slope from "
                f"{slope_steps[0].get('source')!r}, expected 'dem@5000'"
            )

    h = hotspot()
    if len(h["conditions"]) != 13:
        problems.append(f"hotspot.json has {len(h['conditions'])} conditions, expected 13")

    s = susceptibility()
    if len(s["conditions"]) != 13:
        problems.append(f"susceptibility.json has {len(s['conditions'])} conditions, expected 13")
    if s["maxScore"] != len(s["conditions"]):
        problems.append("susceptibility.json maxScore does not match the condition count")

    pal = palettes()
    for band_entry in bands()["bands"]:
        name = band_entry.get("palette")
        if name and name not in pal:
            problems.append(
                f"band {band_entry['key']} references palette {name!r} which is not in palettes.json"
            )

    return problems
