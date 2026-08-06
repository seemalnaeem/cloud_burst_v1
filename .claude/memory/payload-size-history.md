---
name: payload-size-history
description: The previous system shipped 175 MB boundary payloads and 190 MB susceptibility responses, which is why generalization and score-geometry separation are mandatory.
metadata:
  type: project
---

Two measured failures in the old system: districts plus tehsils were about **175 MB** uncompressed
over WFS, and each susceptibility response about **190 MB** because it embedded full district
geometry alongside the scores, which also caused a thundering herd.

**Why:** both avoidable. The boundary payload was full-resolution polygons sent to a browser
rendering them at zoom 6; the susceptibility payload resent geometry the browser already had.

**How to apply:**

- Boundaries go out as MVT with generalized geometry per zoom tier chosen inside the tile function:
  `geom_z6` at 0.05 degrees, `geom_z9` at 0.01, full resolution above zoom 10.
- Score responses return values keyed by `district_name` and nothing else. 190 MB becomes a few KB.
- Keep in-flight de-duplication in the gateway; it is cheap and the failure it prevents is severe.
- Results keyed on `(creation_time, lead_hours)` are immutable, so they cache hard for six hours.

Related: [[three-scoring-models]]