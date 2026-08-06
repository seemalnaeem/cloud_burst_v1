"""District susceptibility.

Thirteen conditions, uniformly stricter than the hotspot mask. The mechanic is
different too: build a binary raster per condition, take its mean over the
district polygon (which for a binary raster is the fraction of area passing),
and count the condition as passed when that fraction reaches 0.5.

Score is the count of passed conditions, 0 to 13, then classified into 5.
"""

from __future__ import annotations

import numpy as np

from app.shared import contracts

_S = contracts.susceptibility()

_OPS = {
    "gt": lambda a, v: a > v,
    "gte": lambda a, v: a >= v,
    "lt": lambda a, v: a < v,
    "lte": lambda a, v: a <= v,
    "eq": lambda a, v: a == v,
}


def condition_masks(arrays: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """One binary array per condition, keyed by condition key."""
    return {
        cond["key"]: _OPS[cond["op"]](arrays[cond["band"]], cond["value"])
        for cond in _S["conditions"]
    }


def score_from_fractions(fractions: dict[str, float]) -> dict:
    """Score a district from per condition area fractions.

    fractions maps a condition key to the share of district area where that
    condition holds, which is the zonal MEAN of the binary condition raster.
    """
    threshold = _S["areaFractionThreshold"]
    passed = {key: (frac is not None and frac >= threshold) for key, frac in fractions.items()}
    total = sum(1 for v in passed.values() if v)
    cls = classify(total)

    return {
        "score": total,
        "max_score": _S["maxScore"],
        "conditions": {
            key: {"fraction": fractions.get(key), "passed": passed.get(key, False)}
            for key in (c["key"] for c in _S["conditions"])
        },
        "class_idx": cls["idx"],
        "class_name": cls["name"],
        "class_color": cls["color"],
    }


def classify(total: int) -> dict:
    for cls in _S["classes"]:
        if cls["min"] <= total <= cls["max"]:
            return cls
    return _S["classes"][-1]


def required_bands() -> set[str]:
    return {c["band"] for c in _S["conditions"]}


def conditions() -> list[dict]:
    return _S["conditions"]


def prioritization_leads() -> list[int]:
    """Leads the prioritized ranking evaluates before taking a peak per
    district."""
    return _S["prioritized"]["leads"]
