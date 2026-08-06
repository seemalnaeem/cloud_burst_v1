"""Hotspot mask, 13 boolean conditions combined with AND.

Distinct from susceptibility, which uses the same variables at stricter
thresholds and a different mechanic. Do not reconcile them, see
.claude/memory/three-scoring-models.md.
"""

from __future__ import annotations

import numpy as np

from app.shared import contracts

_H = contracts.hotspot()

_OPS = {
    "gt": lambda a, v: a > v,
    "gte": lambda a, v: a >= v,
    "lt": lambda a, v: a < v,
    "lte": lambda a, v: a <= v,
    "eq": lambda a, v: a == v,
}


def _apply(arrays: dict[str, np.ndarray], spec: dict) -> np.ndarray:
    """One condition, which may itself be a conjunction.

    The rain condition ANDs precipitation type with rain rate into a single
    entry. Susceptibility keeps those as two separate conditions, which is why
    both lists have thirteen entries and they are not the same thirteen.
    """
    if "all" in spec:
        result: np.ndarray | None = None
        for sub in spec["all"]:
            part = _apply(arrays, sub)
            result = part if result is None else (result & part)
        return result

    band = arrays[spec["band"]]
    return _OPS[spec["op"]](band, spec["value"])


def mask(arrays: dict[str, np.ndarray]) -> np.ndarray:
    """Boolean mask, true where every condition holds.

    arrays maps band key to a 2D array, all on the same grid. Missing a band is
    a KeyError on purpose, silently treating it as passing would produce a mask
    that is wrong in the permissive direction.
    """
    result: np.ndarray | None = None
    for cond in _H["conditions"]:
        part = _apply(arrays, cond)
        result = part if result is None else (result & part)
    return result if result is not None else np.zeros((0, 0), dtype=bool)


def per_condition(arrays: dict[str, np.ndarray]) -> dict[str, int]:
    """Pixel count per condition, plus the final AND.

    This is what the verify view shows. When the mask comes back empty, this
    tells you which single condition killed it, which is almost always more
    useful than the mask itself.
    """
    counts: dict[str, int] = {}
    combined: np.ndarray | None = None

    for cond in _H["conditions"]:
        part = _apply(arrays, cond)
        counts[cond["key"]] = int(part.sum())
        combined = part if combined is None else (combined & part)

    counts["_all"] = int(combined.sum()) if combined is not None else 0
    return counts


def required_bands() -> set[str]:
    """Which bands need to be loaded before calling mask()."""
    out: set[str] = set()

    def walk(spec: dict) -> None:
        if "all" in spec:
            for sub in spec["all"]:
                walk(sub)
        else:
            out.add(spec["band"])

    for cond in _H["conditions"]:
        walk(cond)
    return out


def conditions() -> list[dict]:
    return _H["conditions"]
