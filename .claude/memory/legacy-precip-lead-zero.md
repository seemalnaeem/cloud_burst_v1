---
name: legacy-precip-lead-zero
description: At forecast hour zero the legacy hotspot and susceptibility endpoints compute a precipitation rate of zero, so their rain conditions can never fire.
metadata:
  type: project
---

Found reviewing `app.py`; not in DATA_SOURCES.md section 12, so it is a new finding.

Precipitation is cumulative and zero at lead 0, so every endpoint needs a special case. There are two
different ones.

`_build_ecmwf_image` (line 1318, used by CARI) takes `current = first published lead > 0` and
`previous = 0`, giving a real rate. Hotspots and susceptibility (lines 2859, 3190) fall through to
`current_precip * 1000 / 3`, where `current_precip` is P[0] = 0. Zero everywhere.

**Consequence:** at lead 0 the hotspot mask can never fire, since condition 1 needs a rate above
40 mm/hr. Susceptibility loses `rain_100mm` and caps at 12 of 13. CARI meanwhile reports a real
rainfall grade. The three models disagree at lead 0 for a reason unrelated to their thresholds, and
the failure is silent: an empty hotspot map looks like fair weather.

**How to apply:** the rule belongs in one place. `time.json` carries it under
`precipRate.atLeadZero` as `previous: 0, currentFallbackHours: 3`, which is the CARI behaviour and
the correct one. Implement once in `timeutil`; all three models call it.

Related: DATA_SOURCES.md section 12 item 5 documents a related issue, the hotspot path stepping back
by a hardcoded cadence rather than the previous published lead. `timeutil.previous_published` handles
that. [[three-scoring-models]], [[reducer-semantics]]