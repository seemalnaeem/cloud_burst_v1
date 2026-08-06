---
name: admin-layer-defects
description: Defects found in the delivered admin_final shapefiles and how each one is handled, including the Bagh row mislabelled Poonch.
metadata:
  type: project
---

Found while ingesting `data/vector/admin_final` on 2026-08-06. Each is handled in the ingest rather
than by editing the shapefiles, so the source stays as delivered and the change is auditable.

**Bagh district was labelled Poonch.** District row `id=187` carried the name Poonch, giving three
Poonch rows, while Bagh was absent from a layer that otherwise holds all ten Azad Kashmir districts.
Its numeric attributes are DBF overflow markers, so the row was already damaged. The tehsil layer
carries BAGH with its two tehsils. Confirmed by the project owner and recorded as a row in
`geo.source_correction` with its reason.

**Poonch is genuinely duplicated as a name.** After that correction, Poonch still appears twice, once
in Azad Kashmir and once in IIOJK, on opposite sides of the Line of Control. Different polygons, zero
overlap, 718 and 1671 km2. Not a defect, but it is why `district_name` alone cannot be a key. See
[[join-key-discipline]].

**Attributes duplicated across the Line of Control.** The IIOJK Poonch row carries the Azad Kashmir
Poonch row's `objectid`, `population` and `shape_area` while having its own geometry. Its population
is therefore the other district's. Population for IIOJK is unreliable in general: 21 of 22 rows store
a DBF overflow marker, which the ingest maps to NULL.

**CR LF inside 17 division values.** Values like `'Bannu Division\r\n\r\n        '` hide a carriage
return in the middle of the DBF padding, so a plain right trim leaves it. `geo.clean_text` collapses
whitespace runs before trimming.

**Shape_Area and Shape_Leng are in degrees.** Not areas or lengths. A degree of longitude is 96 km at
Karachi and 88 km at Gilgit, so a southern district is overstated against a northern one by about 10
percent. Dropped on ingest and replaced by geodesic values from `geo.rebuild_measures()`.

**Three spellings per province.** The provincial layer says `Islamabad`, the district layer
`Federal Capital`, the tehsil layer `FEDERAL CAPITAL TERRITORY`. The disputed territory is `IOJK` in
one and the full name in another. Resolved through `geo.province_alias`; an unmapped spelling aborts
the ingest. `IOJK` was missing from the CARI `terrainProvinces` list, which would have scored 22
districts against the lowlands matrix and simply returned lower numbers with no error.

**The tehsil layer is an older vintage.** It predates the 2018 FATA merger and the Karachi, Chitral,
Kohistan and Hunza-Nagar splits. Consequences and the resolution rule are in
`db/ingest/promote_admin.sql`.

**What is internally consistent:** district polygons tile their province polygons exactly, 0.0
percent difference in all eight, so the two layers came from the same authority. Provincial totals
match published figures to within 0.3 percent for Balochistan, Punjab, Sindh and Khyber Pakhtunkhwa.
Azad Kashmir totals 11,025 km2 against a commonly published 13,297, and Gilgit Baltistan 69,926
against 72,971, a difference in where the source draws the Line of Control rather than an ingest
error.

Related: [[join-key-discipline]], [[data-source-status]]