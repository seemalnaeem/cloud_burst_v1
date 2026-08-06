---
name: cari-scoring
description: The three scoring models, CARI, hotspot mask and susceptibility, plus alerts. Use when implementing, changing or debugging a risk score, threshold, class boundary or the alerts feed. Triggers on CARI, hotspot, susceptibility, risk score, threshold, class, alert, terrain matrix, lowlands.
---

# Scoring models

Three independent systems, same inputs, different thresholds, never reconcile them
([[three-scoring-models]]). Authority: DATA_SOURCES.md section 9. Every number comes from
`shared/contracts/` at runtime.

## Variables and reducers

RF, CAPE, TCWV, RH700, VV700, ELEV, WS, DP (primary) | RH500, VV500, T2M, T850, SLOPE (secondary).

VV500 and VV700 reduce with **min** (negative is upward motion); everything else **max**.
[[reducer-semantics]]

Derived at ingest:

```
rate_mm_hr     = (precip[cur] - precip[prev]) * 1000 / interval_h   # mask <= 0
wind_speed_850 = sqrt(u^2 + v^2) * 3.6
```

Source precipitation is cumulative; not differencing gives a season total where an hourly rate
belongs. At lead 0 use the 0-to-3 delta ([[legacy-precip-lead-zero]]).

## CARI

```python
def grade(value, thresholds, order):
    if value is None: return 0
    if order == 'asc':
        for i, t in enumerate(thresholds):
            if value <= t: return i
        return 6
    for i, t in enumerate(thresholds):   # 'desc', VV bands only
        if value > t: return i
    return 6
```

```
cas      = sum(primary) + 0.75 * sum(secondary)
cas_max  = 8*6 + 5*6*0.75 = 70.5
cari_pct = cas / 70.5 * 100
```

Classes: <=15 Very Low, <=30 Low, <=45 Moderate, <=60 Moderately High, <=75 High, <=90 Very High,
else Extreme.

**Primary-extreme override:** count primary variables grading >=5. Six or more floors the class at
Very High, exactly five at High. Raises only, so a class above what the percentage suggests is the
rule working, not a bug.

**Two matrices**, terrain and lowlands, differing on 6 of 13 (CAPE, TCWV, ELEV, DP, T2M, T850).
Selection is a business rule: certain provinces always terrain, Punjab terrain only for Rawalpindi,
Jhelum, Attock, Chakwal and Murree, IIOJK always terrain. An explicit `matrix` parameter overrides,
and the response reports which was used so a surprising score is traceable.

## Hotspot mask

13 conditions AND'ed, then self-masked. Rain is **one** condition: type is rain AND rate > 40 mm/hr.
Full list in `hotspot.json`. Old comments claimed 60 mm/hr and 40 km/hr; the code values (40 and 20)
are correct.

## Susceptibility

13 stricter conditions, different mechanic: a binary raster per condition, **mean** over the district
(the area fraction), passing at 0.5. Score is the count of passed conditions, 0-13.

Rain splits into **two** conditions here (type is rain; rate >= 100) where the hotspot mask ANDs them
into one. That is why both lists have 13 entries and are not the same 13.

Classes: 0-2 Very Low, 3-4 Low, 5-6 Moderate, 7-8 High, 9-13 Very High. The palette reuses CARI hex
values with different meanings.

## Terrain reduction

Slope derives from the **5 km reduced DEM**, not native, then both go to 28 km with a max reducer.
Native-resolution slope inflates every mountain district and both boolean models test 15 degrees.
The per-pixel raster deliberately uses native terrain. [[slope-is-computed-at-5km]]

## Alerts

Districts with class index >= 4. Target is tomorrow midday PKT (UTC+5), rounded to the 3 h grid and
snapped to a **published** lead, since cycles publish incrementally and skip grid points. Both
matrices evaluated, each district under the one its province dictates. Cached per cycle and date.

## Forecast time

Grid 3 h to 144 then 6 h to 360. Read published leads, never assume the grid. Negative leads reach
into past cycles (168 h back, 6 h step). All of it lives once in `shared/timeutil.py`.

## Testing

Golden tests: fixed inputs, expected grades, expected class, updated in the same commit as any
threshold change. Worth asserting: percent in 0-100; `cas_max == 70.5`; null grades 0; strongly
negative VV grades 6 under `desc`; the override raises and never lowers; the six matrix differences;
susceptibility passes at exactly 0.5.