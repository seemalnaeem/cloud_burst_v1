---
name: contracts-single-source
description: Thresholds, palettes, class boundaries and layer definitions live in shared/contracts as JSON, read by all three tiers, never retyped in code.
metadata:
  type: project
---

Every number describing the science or the visual language lives in `shared/contracts/*.json`, read
through one thin loader per tier. A magic number in a component, service or SQL file is a defect even
when currently correct.

**Why:** section 12 of DATA_SOURCES.md records what duplicated constants did to the old system. The
rain threshold had three values depending on where you looked; the wind threshold in code disagreed
with the comment above it; the UI reported 7, 12 or 13 conditions depending on the panel. Predictable,
not careless.

**How to apply:**

- Read through the loader, never `open()` or `fs` at a call site. Loaders validate, cache and strip
  `$`-prefixed comment keys.
- JS and Python cannot share code, so shared knowledge is data. Each tier implements behaviour
  against the same contract, with tests proving agreement on shared fixtures.
- A change touches all five agents: announce it, update loader validation if the shape changed, run
  contract tests in all three tiers, update golden scoring tests in the same commit.

Related: [[three-scoring-models]], [[reducer-semantics]], [[slope-is-computed-at-5km]]