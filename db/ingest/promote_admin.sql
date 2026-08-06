-- Promote the staged administrative layers into geo.*
--
-- Run by scripts/ingest/ingest_admin.py after ogr2ogr has loaded the four
-- shapefiles into stg.*_raw. One transaction for all four layers, because they
-- reference each other: a district needs its province and a tehsil needs its
-- district. Half a load is worse than none.
--
-- What this does to the source attributes:
--
--   trimmed     every text value through geo.clean_text, which collapses
--               whitespace runs (including the CR LF pairs embedded in 17
--               division values) and turns the empty string into NULL
--   dropped     Shape_Leng, Shape_Area, Shape_le_1, Area_Sq_Km. All are in
--               degrees or were computed in an unstated projection
--   recomputed  area_km2 and perimeter_km geodesically from the geometry, by
--               geo.rebuild_measures() after this file commits
--   keyed       content derived text primary keys, stable across a reload
--   corrected   rows listed in geo.source_correction, each with a reason

\set ON_ERROR_STOP on

BEGIN;

-- --------------------------------------------------------------- preflight
-- Fail before touching a live table rather than half way through it.
DO $$
DECLARE
  n_nat  bigint;
  n_prov bigint;
  n_dist bigint;
  n_teh  bigint;
BEGIN
  SELECT count(*) INTO n_nat  FROM stg.national_raw;
  SELECT count(*) INTO n_prov FROM stg.provinces_raw;
  SELECT count(*) INTO n_dist FROM stg.districts_raw;
  SELECT count(*) INTO n_teh  FROM stg.tehsils_raw;

  IF n_nat < 1 OR n_prov < 8 OR n_dist < 180 OR n_teh < 500 THEN
    RAISE EXCEPTION
      'Staging looks wrong: national=%, provinces=%, districts=%, tehsils=%. Expected at least 1, 8, 180, 500.',
      n_nat, n_prov, n_dist, n_teh;
  END IF;
END $$;

-- Every province spelling in every layer must already be in geo.province_alias.
-- Guessing here would put districts under the wrong threshold matrix, which
-- changes their scores and produces no error at all.
DO $$
DECLARE unknown text;
BEGIN
  -- Column names are lower case here even though the shapefiles mix cases:
  -- ogr2ogr launders identifiers on load, so Province and OBJECTID arrive as
  -- province and objectid.
  SELECT string_agg(DISTINCT quote_literal(s), ', ') INTO unknown FROM (
    SELECT geo.clean_text(province) AS s FROM stg.provinces_raw
    UNION SELECT geo.clean_text(province) FROM stg.districts_raw
    UNION SELECT geo.clean_text(province) FROM stg.tehsils_raw
  ) v WHERE s IS NOT NULL AND geo.resolve_province(s) IS NULL;

  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION
      'Unmapped province spellings: %. Add them to geo.province_alias in db/init/04_admin_reference.sql.',
      unknown;
  END IF;
END $$;

-- ---------------------------------------------------------------- national
-- The source holds four rows: mainland Pakistan, two small Pakistani islands
-- and the disputed territory. Dissolving by country turns that into one row
-- per country, which is what every consumer of this layer actually wants.
TRUNCATE geo.national;

INSERT INTO geo.national (national_code, name, name_src, geom)
SELECT
  CASE WHEN geo.name_key(nm) = 'PAKISTAN' THEN 'PAK' ELSE 'IJK' END,
  CASE WHEN geo.name_key(nm) = 'PAKISTAN' THEN 'Pakistan'
       ELSE 'Indian Illegally Occupied Jammu & Kashmir' END,
  nm,
  ST_Multi(ST_UnaryUnion(ST_Collect(geom)))
FROM (
  SELECT geo.clean_text(admin01_na) AS nm, ST_MakeValid(geom) AS geom
  FROM stg.national_raw
) s
WHERE nm IS NOT NULL
GROUP BY 1, 2, 3;

-- --------------------------------------------------------------- provinces
-- The eight rows already exist, seeded with their codes in
-- 04_admin_reference.sql. This attaches geometry and the source spelling.
UPDATE geo.provinces p SET
  province_src = s.nm,
  objectid     = s.oid,
  geom         = s.geom,
  ingested_at  = now()
FROM (
  SELECT geo.resolve_province(geo.clean_text(province)) AS code,
         geo.clean_text(province)                       AS nm,
         objectid::bigint                               AS oid,
         ST_Multi(ST_MakeValid(geom))                   AS geom
  FROM stg.provinces_raw
) s
WHERE p.province_code = s.code;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM geo.provinces WHERE geom IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '% seeded provinces got no geometry from the provincial layer.', n;
  END IF;
END $$;

-- --------------------------------------------------------------- districts
-- Order of operations matters: clean, then correct, then key. Keying before
-- correcting would derive the primary key from the name we are replacing.
TRUNCATE geo.districts CASCADE;

WITH src AS (
  SELECT
    r.id::text                     AS src_id,
    geo.clean_text(r.districts)    AS name_src,
    geo.clean_text(r.province)     AS prov_src,
    geo.clean_text(r.division)     AS division,
    r.population                   AS population,
    ST_Multi(ST_MakeValid(r.geom)) AS geom
  FROM stg.districts_raw r
),
corrected AS (
  SELECT s.*,
         coalesce(c.new_value, s.name_src) AS district_name
  FROM src s
  LEFT JOIN geo.source_correction c
    ON c.layer = 'districts' AND c.field = 'districts' AND c.src_id = s.src_id
)
INSERT INTO geo.districts (
  district_code, district_name, province_code, province, province_src,
  division, country, population, geom
)
SELECT
  geo.resolve_province(c.prov_src) || '-' || geo.name_key(c.district_name),
  c.district_name,
  p.province_code,
  p.province,
  c.prov_src,
  c.division,
  -- Canonical country from the province, not from the row. The source leaves
  -- it blank on 21 of the 22 disputed rows and says India on the 22nd, so
  -- taking it per row would keep that inconsistency.
  p.country,
  -- The DBF stores an overflow marker rather than a number for the disputed
  -- districts, which arrives here as NULL or zero. No Pakistani district has
  -- a population of zero, so zero means unknown.
  CASE WHEN c.population > 0 THEN round(c.population)::bigint END,
  c.geom
FROM corrected c
JOIN geo.provinces p ON p.province_code = geo.resolve_province(c.prov_src)
WHERE c.district_name IS NOT NULL;

-- ----------------------------------------------------------------- tehsils
TRUNCATE geo.tehsils;

INSERT INTO geo.tehsils (
  tehsil_code, tehsil, district_src, province_code, province, province_src, geom
)
SELECT
  geo.resolve_province(t.prov_src) || '-' ||
    geo.name_key(t.district_src) || '-' || geo.name_key(t.tehsil),
  t.tehsil,
  t.district_src,
  p.province_code,
  p.province,
  t.prov_src,
  t.geom
FROM (
  SELECT geo.clean_text(tehsil)         AS tehsil,
         geo.clean_text(district)       AS district_src,
         geo.clean_text(province)       AS prov_src,
         ST_Multi(ST_MakeValid(geom))   AS geom
  FROM stg.tehsils_raw
) t
JOIN geo.provinces p ON p.province_code = geo.resolve_province(t.prov_src)
WHERE t.tehsil IS NOT NULL AND t.district_src IS NOT NULL;

-- ------------------------------------------------- district name alias table
-- The tehsil layer predates the 2018 FATA merger and the Karachi, Chitral,
-- Kohistan and Hunza-Nagar splits, so it names districts the current district
-- layer no longer carries. Every row below is a reviewed decision.
--
-- Deliberately absent: CHITRAL, KARACHI, KOHISTAN and HUNZA NAGAR. Each of
-- those single old districts became several new ones, so there is no correct
-- one to one target. Their tehsils are resolved by geometry instead, which is
-- exact where a name guess would not be.
DELETE FROM geo.district_alias;

INSERT INTO geo.district_alias (province_code, alias_key, district_code, note)
SELECT v.province_code, v.alias_key,
       v.province_code || '-' || v.target_key,
       v.note
FROM (VALUES
  -- Punjab
  ('PJB', 'PAKPATTAN',              'PAKPATTAN',        'spacing differs, Pak Pattan'),
  -- Sindh
  ('SND', 'MIRPURKHAS',             'MIRPURKHAS',       'spacing differs, Mirpur Khas'),
  ('SND', 'THARPARKAR',             'THARPARKAR',       'spacing differs, Thar Parkar'),
  ('SND', 'TANDOALLAHYAR',          'TANDOALLAHYAR',    'spacing differs, Tando Allah Yar'),
  ('SND', 'SHAHEEDBENAZIRABAD',     'SHAHEEDBENAZIRABAD', 'spacing differs'),
  ('SND', 'SHAHDADKOT',             'QAMBARSHAHDADKOT', 'renamed Qambar Shahdadkot'),
  -- Balochistan
  ('BAL', 'KACHHIBOLAN',            'KACHHI',           'source writes Kachhi(Bolan)'),
  ('BAL', 'MUSAKHEL',               'MUSAKHEL',         'spacing differs, Musa Khel'),
  ('BAL', 'SHEERANI',               'SHERANI',          'transliteration differs'),
  -- Azad Kashmir
  ('AJK', 'NEELUM',                 'NEELAMVALLEY',     'district layer says Neelam Valley'),
  -- Khyber Pakhtunkhwa, spelling
  ('KPK', 'NOWSHEHRA',              'NOWSHERA',         'source value is NOWSHEHRA_ with a trailing underscore'),
  ('KPK', 'TORGHER',                'TORGHAR',          'spacing differs, Tor Ghar'),
  ('KPK', 'MALAKANDPROTECTEDAREA',  'MALAKAND',         'now simply Malakand district'),
  -- Khyber Pakhtunkhwa, the 2018 FATA merger. The seven agencies became
  -- districts under the same name.
  ('KPK', 'BAJAURAGENCY',           'BAJAUR',           'agency became a district in 2018'),
  ('KPK', 'KHYBERAGENCY',           'KHYBER',           'agency became a district in 2018'),
  ('KPK', 'KURRAMAGENCY',           'KURRAM',           'agency became a district in 2018'),
  ('KPK', 'MOHMANDAGENCY',          'MOHMAND',          'agency became a district in 2018'),
  ('KPK', 'ORAKZAIAGENCY',          'ORAKZAI',          'agency became a district in 2018'),
  ('KPK', 'NORTHWAZIRISTANAGENCY',  'NORTHWAZIRISTAN',  'agency became a district in 2018'),
  ('KPK', 'SOUTHWAZIRISTANAGENCY',  'SOUTHWAZIRISTAN',  'agency became a district in 2018'),
  -- The six Frontier Regions were merged into the settled district they were
  -- named after, so each one has a single unambiguous parent.
  ('KPK', 'FRBANNU',                'BANNU',            'Frontier Region merged into Bannu in 2018'),
  ('KPK', 'FRDIKHAN',               'DERAISMAILKHAN',   'Frontier Region merged into Dera Ismail Khan in 2018'),
  ('KPK', 'FRKOHAT',                'KOHAT',            'Frontier Region merged into Kohat in 2018'),
  ('KPK', 'FRLAKKIMARWAT',          'LAKKIMARWAT',      'Frontier Region merged into Lakki Marwat in 2018'),
  ('KPK', 'FRPESHAWAR',             'PESHAWAR',         'Frontier Region merged into Peshawar in 2018'),
  ('KPK', 'FRTANK',                 'TANK',             'Frontier Region merged into Tank in 2018')
) AS v(province_code, alias_key, target_key, note)
-- An alias whose target no longer exists is a silent hole, so require it.
WHERE EXISTS (
  SELECT 1 FROM geo.districts d
  WHERE d.district_code = v.province_code || '-' || v.target_key
);

DO $$
DECLARE n integer;
BEGIN
  SELECT 26 - count(*) INTO n FROM geo.district_alias;
  IF n <> 0 THEN
    RAISE EXCEPTION
      '% alias rows point at a district_code that does not exist. Check the district layer spellings.', n;
  END IF;
END $$;

-- ------------------------------------------------------ resolve tehsil parents
-- One statement that weighs both kinds of evidence, rather than a chain of
-- passes where whichever runs first wins.
--
-- Neither evidence source is reliable alone:
--
--   Name alone is wrong 36 times. district_src is a label from an older
--   revision of the boundaries, so where a district has since been split the
--   old name still matches something real and the match is confidently wrong.
--   HUB and GADDANI are labelled LASBELA, Lasbela still exists, and both
--   polygons now lie inside Hub district. Name matching put those 36 tehsils in
--   a district containing 32 percent of them on average.
--
--   Geometry alone is wrong 3 times, all of them tehsils that straddle a
--   boundary. Sukkur tehsil has 40 percent of its area in Sukkur district and
--   60 percent across the Indus in Khairpur, so pure area assigns a tehsil
--   named SUKKUR, in a source that calls its district SUKKUR, to Khairpur.
--
-- So: the name decides when it is backed by a real share of the area, and
-- geometry decides otherwise. A third is the threshold. It is low enough to
-- keep Sukkur at 40 percent and Gulistan at 50, and high enough to reject the
-- stale names, which cling to their old district by a few percent at most.
-- The gap between those two groups is wide, so the exact cut is not delicate.
WITH candidate AS (
  SELECT t.tehsil_code,
         d.district_code,
         ST_Area(ST_Intersection(t.geom, d.geom))
           / NULLIF(ST_Area(t.geom), 0)                     AS area_fraction,
         -- The name agrees if it matches directly or through a reviewed alias.
         --
         -- Both comparisons are wrapped in coalesce because a.district_code is
         -- NULL whenever the LEFT JOIN finds no alias, which makes the whole
         -- expression NULL rather than false. Postgres sorts NULLS FIRST under
         -- DESC, so those rows would outrank the genuine matches and win the
         -- DISTINCT ON below. That put Gulistan in Pishin and Dasht in Quetta.
         (coalesce(d.district_key = geo.name_key(t.district_src), false)
          OR coalesce(d.district_code = a.district_code, false))  AS name_agrees
  FROM geo.tehsils t
  JOIN geo.districts d
    ON d.province_code = t.province_code
   -- Bounding box first so the GiST index eliminates most pairs. Without it
   -- this intersects every tehsil against every district in its province,
   -- across 108 MB of district outline.
   --
   -- On geom, not geom_z9. The generalized columns are still NULL here: they
   -- are rebuilt after this transaction commits, and && against NULL yields
   -- NULL, which matched nothing and left all 553 tehsils unresolved.
   AND d.geom && t.geom
   AND ST_Intersects(d.geom, t.geom)
  LEFT JOIN geo.district_alias a
    ON a.province_code = t.province_code
   AND a.alias_key     = geo.name_key(t.district_src)
),
chosen AS (
  SELECT DISTINCT ON (tehsil_code)
         tehsil_code,
         district_code,
         CASE WHEN name_agrees AND area_fraction >= 0.33 THEN 'confirmed'
              ELSE 'spatial' END AS link_method
  FROM candidate
  ORDER BY tehsil_code,
           (name_agrees AND area_fraction >= 0.33) DESC NULLS LAST,  -- name plus real area wins
           area_fraction DESC NULLS LAST                             -- otherwise the largest share
)
UPDATE geo.tehsils t
SET district_code = c.district_code,
    link_method   = c.link_method
FROM chosen c
WHERE t.tehsil_code = c.tehsil_code;

COMMIT;

-- Measures are derived, so they sit outside the transaction that establishes
-- the facts. Geometry itself is stored and served at full source resolution;
-- there are no generalized copies to rebuild.
SELECT geo.rebuild_measures();
SELECT geo.analyze_boundaries();
