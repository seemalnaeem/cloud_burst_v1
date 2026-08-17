"""CARI, the Convective Activity Risk Index.

Thirteen variables graded 0 to 6, weighted, summed, expressed as a percentage
and classified. Every number comes from shared/contracts/cari.json. If you find
yourself typing 70.5 or 0.75 into this file, stop.

See .claude/skills/cari-scoring/SKILL.md for the reasoning behind the mechanics.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from app.shared import contracts

_C = contracts.cari()
_VARS = {v["key"]: v for v in _C["variables"]}
_ORDER = [v["key"] for v in _C["variables"]]


def _normalize(text: str | None) -> str:
    return re.sub(r"[^A-Za-z]", "", text or "").lower()


def grade(value: float | None, thresholds: list[float], order: str) -> int:
    """Grade one value against its six thresholds.

    Ascending: the grade is the index of the first threshold the value does not
    exceed. Descending, used only by the two vertical velocity bands: the grade
    is the index of the first threshold the value is still above, because a
    more negative value means a stronger updraft and therefore a higher grade.

    A missing value grades 0. Forecast gaps are normal, not exceptional.
    """
    if value is None:
        return 0

    if order == "asc":
        for i, t in enumerate(thresholds):
            if value <= t:
                return i
        return 6

    for i, t in enumerate(thresholds):
        if value > t:
            return i
    return 6


def grade_array(values: np.ndarray, thresholds: list[float], order: str) -> np.ndarray:
    """grade(), vectorized over a whole grid, for the per pixel CAR Index raster.

    Same rule as the scalar grade, read as a count so it runs on an array at once.
    Ascending: the grade is how many thresholds the value exceeds, since the
    thresholds are sorted and a value clears a prefix of them. Descending, the two
    vertical velocity bands: the grade is how many thresholds the value is still
    at or below, because a more negative value means a stronger updraft.

    A NaN cell, which is how a missing or off-domain pixel arrives, grades 0, the
    same as grade(None). This is forced rather than left to the comparison, because
    for a descending band NaN compares false to `>` and would otherwise count as 6.
    """
    v = values[..., np.newaxis]
    t = np.asarray(thresholds, dtype="float64")
    if order == "asc":
        g = (v > t).sum(axis=-1)
    else:
        g = (v <= t).sum(axis=-1)
    g = g.astype("float64")
    g[np.isnan(values)] = 0
    return g


def score_grid(arrays: dict[str, np.ndarray], terrain_mask: np.ndarray) -> np.ndarray:
    """The CAR Index percentage on every cell, from aligned per variable arrays.

    arrays is keyed by variable key (RF, CAPE, ...), each a 2D array already on the
    common grid. terrain_mask is 1 where a cell scores against the terrain matrix
    and 0 where it scores against lowlands, so the thresholds are picked cell by
    cell exactly as terrain_class picks them per district. The weighting, the
    casMax normalisation and the primary extreme override are the same numbers the
    scalar path uses, read from the contract, applied per pixel.
    """
    matrices = _C["matrices"]
    weights = _C["weights"]
    terrain = terrain_mask.astype(bool)

    primary_sum = np.zeros(terrain.shape, dtype="float64")
    secondary_sum = np.zeros(terrain.shape, dtype="float64")
    extreme_count = np.zeros(terrain.shape, dtype="float64")

    ov = _C["primaryExtremeOverride"]

    for key in _ORDER:
        spec = _VARS[key]
        raw = arrays.get(key)
        if raw is None:
            raw = np.full(terrain.shape, np.nan, dtype="float64")

        if "clamp" in spec:
            low, high = spec["clamp"]
            raw = np.clip(raw, low, high)

        g_terrain = grade_array(raw, matrices["terrain"]["thresholds"][key], spec["order"])
        g_lowland = grade_array(raw, matrices["lowlands"]["thresholds"][key], spec["order"])
        g = np.where(terrain, g_terrain, g_lowland)

        if spec["tier"] == "primary":
            primary_sum += g
            extreme_count += (g >= ov["gradeAtLeast"])
        else:
            secondary_sum += g

    cas = primary_sum * weights["primary"] + secondary_sum * weights["secondary"]
    percent = cas / _C["casMax"] * 100.0

    # Primary extreme override, per pixel. It raises the class floor only, so it is
    # expressed here as a floor on the percentage: a triggered cell is lifted to the
    # bottom of the class the rule demands. Rules are applied strongest first, and
    # since a higher count implies every lower one, the maximum wins on its own.
    classes = _C["classes"]
    floor = np.zeros(terrain.shape, dtype="float64")
    for rule in sorted(ov["rules"], key=lambda r: -r["countAtLeast"]):
        idx = rule["floorClassIdx"]
        lower = classes[idx - 1]["max"] if idx > 0 else 0
        floor = np.where((floor == 0) & (extreme_count >= rule["countAtLeast"]), lower, floor)
    percent = np.maximum(percent, floor)

    return np.clip(percent, 0, 100).astype("float32")


def terrain_class(province: str | None, district: str | None) -> str:
    """Which threshold matrix a district scores against.

    A business rule, not data. Mirrored in score.terrain_class in the database
    so an analyst querying directly gets the same answer, and a test keeps the
    two in step.
    """
    sel = _C["matrixSelection"]
    p = _normalize(province)

    if p in sel["terrainProvinces"]:
        return "terrain"

    if p.startswith("punjab"):
        # Normalize both sides: the district layer spells these Title Case
        # (Rawalpindi) but the tehsil layer files the parent district upper case
        # (RAWALPINDI), and a raw comparison would send every Potohar tehsil to
        # the lowlands matrix and score it on the wrong thresholds.
        terrain_districts = {_normalize(d) for d in sel["punjabTerrainDistricts"]}
        return "terrain" if _normalize(district) in terrain_districts else "lowlands"

    return sel["default"]


def classify(percent: float) -> dict:
    for cls in _C["classes"]:
        if percent <= cls["max"]:
            return cls
    return _C["classes"][-1]


@dataclass
class CariResult:
    matrix: str
    values: dict[str, float | None]
    scores: dict[str, int] = field(default_factory=dict)
    primary_sum: float = 0.0
    secondary_sum: float = 0.0
    cas: float = 0.0
    cas_max: float = 0.0
    cari: float = 0.0
    class_idx: int = 0
    risk_level: str = ""
    risk_color: str = ""
    override_applied: bool = False


def score(values: dict[str, float | None], matrix: str) -> CariResult:
    """Score one district.

    values is keyed by variable key (RF, CAPE, ...) and already reduced to a
    single number per district. The reducer used to get there is part of the
    contract and differs per variable, min for vertical velocity and max for
    everything else. See .claude/memory/reducer-semantics.md.
    """
    if matrix not in _C["matrices"]:
        raise ValueError(f"Unknown matrix {matrix!r}")

    thresholds = _C["matrices"][matrix]["thresholds"]
    weights = _C["weights"]

    scores: dict[str, int] = {}
    primary_sum = 0.0
    secondary_sum = 0.0

    for key in _ORDER:
        spec = _VARS[key]
        raw = values.get(key)

        if raw is not None and "clamp" in spec:
            low, high = spec["clamp"]
            raw = min(max(raw, low), high)

        g = grade(raw, thresholds[key], spec["order"])
        scores[key] = g

        if spec["tier"] == "primary":
            primary_sum += g
        else:
            secondary_sum += g

    cas = primary_sum * weights["primary"] + secondary_sum * weights["secondary"]
    cas_max = _C["casMax"]
    percent = cas / cas_max * 100.0

    cls = classify(percent)
    class_idx = cls["idx"]
    override_applied = False

    # Primary extreme override. Counts primary variables grading at the top and
    # raises the class floor. It only ever raises, so a class higher than the
    # percentage alone suggests is expected rather than a bug.
    ov = _C["primaryExtremeOverride"]
    extreme_count = sum(
        1 for k, g in scores.items() if _VARS[k]["tier"] == "primary" and g >= ov["gradeAtLeast"]
    )
    for rule in ov["rules"]:
        if extreme_count >= rule["countAtLeast"] and class_idx < rule["floorClassIdx"]:
            class_idx = rule["floorClassIdx"]
            override_applied = True
            break

    final = _C["classes"][class_idx]

    return CariResult(
        matrix=matrix,
        values=values,
        scores=scores,
        primary_sum=primary_sum,
        secondary_sum=secondary_sum,
        cas=round(cas, 4),
        cas_max=cas_max,
        cari=round(percent, 2),
        class_idx=class_idx,
        risk_level=final["name"],
        risk_color=final["color"],
        override_applied=override_applied,
    )


def variable_specs() -> list[dict]:
    """Variable catalog, for callers that need to know what to fetch and how to
    reduce it."""
    return _C["variables"]


def reducers() -> dict[str, str]:
    """Variable key to reducer name. Pass these to zonal statistics, do not
    default them."""
    return {v["key"]: v["reducer"] for v in _C["variables"]}


def source_priority() -> list[str]:
    """The order the resolver prefers models in when a variable is sourced 'auto'.

    A variable graded against a band is read from the first model here that
    catalogues that band. Wind and vertical velocity exist only under GFS so they
    fall through to it; precipitable water only under GRAPES so it falls to the
    backstop; everything else resolves to the model at the top of the list.
    """
    return list(_C.get("sourcePriority") or [])
