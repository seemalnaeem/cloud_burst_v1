---
name: three-scoring-models
description: CARI, the hotspot mask and district susceptibility share input variables but use deliberately different thresholds and must never be reconciled.
metadata:
  type: project
---

**CARI** grades 13 variables 0-6, weights 8 primary at 1.0 and 5 secondary at 0.75, max 70.5,
percent, 7 classes. **Hotspot mask** ANDs 13 booleans into a binary mask. **Susceptibility** counts
13 stricter thresholds holding over at least half the district area, 0-13, 5 classes.

Susceptibility is uniformly stricter: CAPE 1000 vs 1500, VV700 -0.02 vs -0.2 (tenfold), RH700 60 vs
80, elevation 1000 vs 1500. Rain composes differently: the hotspot mask ANDs "type is rain" with
"rate > 40" into **one** condition, susceptibility counts "type is rain" and "rate >= 100" as **two**.
That is why both lists have 13 entries and are not the same 13.

**Why:** they answer different questions. CARI is a graded index for ranking and alerting, the
hotspot mask a strict "all conditions present now" overlay, susceptibility an area-based measure for
prioritisation. Someone will eventually notice the numbers differ and try to unify them. That would
be wrong.

**How to apply:** separate contract files, model modules and tests. Touching one does not touch the
others. If a threshold change is requested, confirm which model first.

CARI also has two matrices, terrain and lowlands, differing on 6 of 13 (CAPE, TCWV, ELEV, DP, T2M,
T850). Selection is a business rule: some provinces always terrain, Punjab terrain only for five
named districts, IIOJK always terrain.

Related: [[contracts-single-source]], [[reducer-semantics]], [[slope-is-computed-at-5km]]