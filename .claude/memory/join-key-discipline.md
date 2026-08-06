---
name: join-key-discipline
description: district_code is the primary key and the thing to join on; district_name is the exact source string and is unique only within a province.
metadata:
  type: project
---

`geo.districts.district_code` is the primary key: `province_code || '-' || geo.name_key(district_name)`,
for example `AJK-POONCH`. Content derived, so it survives a full reload. Join on this.

`district_name` holds the name exactly as the source spells it, original case and spacing. It is
**not globally unique**: Poonch exists in Azad Kashmir and again in IIOJK, two different districts of
718 and 1671 km2 with zero overlap. The unique constraint is `(province_code, district_name)`.

`score.*` tables still key on `district_name` alone, which is therefore ambiguous for Poonch. Open
decision, see [[data-source-status]].

**Why a surrogate id was rejected:** a `bigserial` shifts on every reload, so any cached selection or
foreign key silently repoints at a different district.

**Why the exact string is preserved:** the name crosses four independent boundaries. Normalizing on
one side and not the others makes districts silently disappear. No error, the join just returns
nothing, and it reads as a district with no data rather than a bug.

**How to apply:**

- Never `lower()`, `trim()` or title-case `district_name` in place. `geo.clean_text` at ingest
  collapses whitespace and that is the only change it ever gets.
- Use the generated `district_key` and the trigram index to **find** candidates. Never join on it.
- Province spellings resolve through `geo.province_alias`, never by guessing. Three layers spell
  Islamabad three ways and the disputed territory two ways.
- `meta.check_integrity()` after any boundary ingest. It reports duplicate names, unresolved tehsil
  parents and orphaned score rows.

**Tehsil to district is not a name join.** The tehsil layer predates the 2018 district changes, so
its `district_src` is a stale label. Resolution weighs geometry and name together, recorded in
`link_method`. Reasoning in `db/ingest/promote_admin.sql`.

**When a new source arrives:** diff into exact matches, near matches and one-sided names. Near
matches get a reviewed row in `geo.district_alias`; one-sided names are new districts, renames or
splits, each needing a decision. Never fuzzy match a join key silently.

Related: [[contracts-single-source]], [[data-source-status]], [[admin-layer-defects]]