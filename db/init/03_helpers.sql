-- Reusable database functions.
--
-- Anything used by more than one caller lives here as a real function rather
-- than being copy pasted into a service. The gateway, the API and an ad hoc
-- psql session then all get identical results.

-- Suggest the closest district name. Powers the "did you mean" on a 404 and
-- the matching of district names out of scraped advisory text.
CREATE OR REPLACE FUNCTION geo.suggest_district(candidate text, limit_n integer DEFAULT 5)
RETURNS TABLE (district_code text, district_name text, province text, score real) AS $$
  SELECT d.district_code, d.district_name, d.province,
         similarity(d.district_name, candidate) AS score
  FROM geo.districts d
  WHERE d.district_name % candidate
     OR d.district_key = geo.name_key(candidate)
  ORDER BY score DESC, d.district_name
  LIMIT limit_n;
$$ LANGUAGE sql STABLE;

-- Resolve any province spelling to its code. Returns NULL when the spelling is
-- not in the alias table, which callers must treat as an error rather than a
-- default: silently bucketing an unknown province changes which threshold
-- matrix its districts score against.
CREATE OR REPLACE FUNCTION geo.resolve_province(spelling text)
RETURNS text AS $$
  SELECT a.province_code FROM geo.province_alias a
  WHERE a.alias_key = geo.name_key(spelling);
$$ LANGUAGE sql STABLE;

-- Bounding box and a label point for a district. ST_PointOnSurface rather than
-- ST_Centroid, because the centroid of a crescent shaped district lands
-- outside it and the label ends up pointing at a neighbour.
CREATE OR REPLACE FUNCTION geo.district_extent(code_in text)
RETURNS TABLE (west double precision, south double precision,
               east double precision, north double precision,
               lon double precision, lat double precision) AS $$
  SELECT ST_XMin(env), ST_YMin(env), ST_XMax(env), ST_YMax(env),
         ST_X(pt), ST_Y(pt)
  FROM (
    SELECT ST_Envelope(geom) AS env, coalesce(centroid, ST_PointOnSurface(geom)) AS pt
    FROM geo.districts WHERE district_code = code_in
  ) s;
$$ LANGUAGE sql STABLE;

-- Which threshold matrix a district scores against. Business rule, mirrored in
-- backend/app/models/cari.py and covered by a test that keeps the two in step.
-- Kept here as well so an analyst querying directly gets the same answer.
CREATE OR REPLACE FUNCTION score.terrain_class(province_in text, district_in text)
RETURNS text AS $$
DECLARE p text;
BEGIN
  p := lower(regexp_replace(coalesce(province_in, ''), '[^A-Za-z]', '', 'g'));

  IF p IN ('azadkashmir','ajk','azadjammukashmir',
           'federalcapital','islamabad','islamabadcapitalterritory',
           'gilgitbaltistan','gb',
           'indianillegallyoccupiedjammukashmir','iiojk','jammuandkashmir',
           'khyberpakhtunkhwa','kpk','kp') THEN
    RETURN 'terrain';
  END IF;

  IF p LIKE 'punjab%' THEN
    -- Normalize the district the same way as the province: the district layer
    -- spells these Title Case but the tehsil layer files the parent district
    -- upper case, and a raw comparison would drop every Potohar tehsil to the
    -- lowlands matrix. Kept in step with app.models.cari.terrain_class.
    IF lower(regexp_replace(coalesce(district_in, ''), '[^A-Za-z]', '', 'g'))
       IN ('rawalpindi','jhelum','attock','chakwal','murree') THEN
      RETURN 'terrain';
    END IF;
    RETURN 'lowlands';
  END IF;

  RETURN 'lowlands';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Refresh planner statistics. Call after any boundary ingest.
--
-- This used to also build generalized geometry copies at 5.5 km and 1.1 km
-- tolerance for the tile functions to pick by zoom. Both are gone: the
-- districts hold 6.8 million vertices and a 5.5 km tolerance reduced them to
-- 2,899, which drew Pakistan as a rough polygon at national zoom. Tiles now
-- serve full resolution and let the MVT grid do the thinning per zoom.
CREATE OR REPLACE FUNCTION geo.analyze_boundaries()
RETURNS void AS $$
BEGIN
  ANALYZE geo.districts;
  ANALYZE geo.provinces;
  ANALYZE geo.national;
  ANALYZE geo.tehsils;
END;
$$ LANGUAGE plpgsql;

-- Recompute area, perimeter and the label point from the geometry itself.
-- Replaces the Shape_Area and Shape_Leng columns the sources carry, which are
-- in degrees and therefore not areas or lengths at all.
--
-- The geography cast is what makes these real: it measures on the WGS84
-- spheroid, so a district in Sindh and one in Gilgit are directly comparable.
-- Casting to a projected CRS instead would need a different zone per province.
--
-- ST_PointOnSurface, not ST_Centroid. The centroid of a crescent shaped
-- district lands outside it and the label then points at a neighbour.
CREATE OR REPLACE FUNCTION geo.rebuild_measures()
RETURNS void AS $$
BEGIN
  UPDATE geo.national SET
    area_km2     = ST_Area(geom::geography) / 1e6,
    perimeter_km = ST_Perimeter(geom::geography) / 1000.0,
    centroid     = ST_PointOnSurface(geom);

  UPDATE geo.provinces SET
    area_km2     = ST_Area(geom::geography) / 1e6,
    perimeter_km = ST_Perimeter(geom::geography) / 1000.0,
    centroid     = ST_PointOnSurface(geom)
  WHERE geom IS NOT NULL;

  UPDATE geo.districts SET
    area_km2     = ST_Area(geom::geography) / 1e6,
    perimeter_km = ST_Perimeter(geom::geography) / 1000.0,
    centroid     = ST_PointOnSurface(geom);

  UPDATE geo.tehsils SET
    area_km2     = ST_Area(geom::geography) / 1e6,
    perimeter_km = ST_Perimeter(geom::geography) / 1000.0,
    centroid     = ST_PointOnSurface(geom);
END;
$$ LANGUAGE plpgsql;

-- Post ingest health check. Run it after every boundary load. An orphaned
-- score row means the join key changed, which otherwise fails silently by
-- making districts disappear from results with no error anywhere.
CREATE OR REPLACE FUNCTION meta.check_integrity()
RETURNS TABLE (check_name text, status text, detail text) AS $$
BEGIN
  RETURN QUERY
  SELECT 'invalid_district_geometry',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'fail' END,
         count(*) || ' invalid geometries'
  FROM geo.districts WHERE NOT ST_IsValid(geom);

  RETURN QUERY
  SELECT 'orphaned_cari_scores',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'fail' END,
         count(*) || ' score rows with no matching district'
  FROM score.cari s LEFT JOIN geo.districts d USING (district_name)
  WHERE d.district_name IS NULL;

  RETURN QUERY
  SELECT 'district_extent',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'fail' END,
         'districts outside the plausible Pakistan extent: ' || count(*)
  FROM geo.districts
  WHERE NOT ST_Intersects(geom, ST_MakeEnvelope(59, 22, 79, 38, 4326));

  -- district_name is the join key used by score.*, so a name that repeats
  -- across provinces makes those joins ambiguous even though the table itself
  -- is keyed correctly on district_code.
  RETURN QUERY
  SELECT 'district_name_globally_unique',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'warn' END,
         coalesce(string_agg(district_name || ' (' || n || ')', ', '),
                  'every district name is unique across provinces')
  FROM (SELECT district_name, count(*) AS n FROM geo.districts
        GROUP BY district_name HAVING count(*) > 1) dup;

  RETURN QUERY
  SELECT 'measures_present',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'warn' END,
         count(*) || ' districts without area, perimeter or label point'
  FROM geo.districts
  WHERE area_km2 IS NULL OR perimeter_km IS NULL OR centroid IS NULL;

  RETURN QUERY
  SELECT 'tehsil_parent_resolved',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'warn' END,
         count(*) || ' tehsils with no parent district'
  FROM geo.tehsils WHERE district_code IS NULL;

  -- The real test of the reconciliation. Not "is the tehsil inside its parent",
  -- because the two layers are different vintages and some old tehsils
  -- genuinely straddle two new districts, but "of the districts this tehsil
  -- touches, did it get the one it overlaps most". Anything else is an error.
  --
  -- Both tehsil checks lead with the && operator so the GiST index eliminates
  -- most pairs before any intersection runs. Without it this pairs 553 tehsils
  -- with every district in their province and intersects 103 MB of outline,
  -- which takes minutes rather than seconds.
  RETURN QUERY
  WITH shared AS (
    SELECT t.tehsil_code,
           t.district_code AS chosen,
           d.district_code AS candidate,
           ST_Area(ST_Intersection(t.geom, d.geom)) AS overlap_area,
           ST_Area(t.geom) AS tehsil_area
    FROM geo.tehsils t
    JOIN geo.districts d
      ON d.province_code = t.province_code
     AND d.geom && t.geom
     AND ST_Intersects(d.geom, t.geom)
  ),
  best AS (
    SELECT DISTINCT ON (tehsil_code) tehsil_code, chosen, candidate
    FROM shared ORDER BY tehsil_code, overlap_area DESC
  ),
  -- Only a link decided by area alone has to be the largest area. A confirmed
  -- link deliberately outranks area, because the tehsil's own district_src
  -- named that district: Sukkur tehsil is 40 percent inside Sukkur district and
  -- 60 percent across the Indus, and it still belongs to Sukkur.
  -- Both rows come out of one statement because a CTE is scoped to the single
  -- query that declares it, and recomputing this one twice is not free.
  disagreeing AS (
    SELECT t.link_method, count(*) AS n
    FROM best b JOIN geo.tehsils t USING (tehsil_code)
    WHERE b.chosen IS DISTINCT FROM b.candidate
    GROUP BY t.link_method
  )
  SELECT 'tehsil_parent_is_best_overlap',
         CASE WHEN coalesce(max(n) FILTER (WHERE link_method = 'spatial'), 0) = 0
              THEN 'ok' ELSE 'fail' END,
         coalesce(max(n) FILTER (WHERE link_method = 'spatial'), 0)
           || ' area matched tehsils attached to a district they overlap less than another'
  FROM disagreeing
  UNION ALL
  SELECT 'tehsil_name_overrode_area',
         'info',
         coalesce(max(n) FILTER (WHERE link_method = 'confirmed'), 0)
           || ' tehsils kept the district their own attribute names, against a larger overlap elsewhere'
  FROM disagreeing;

  -- Informational, not a defect. A tehsil that spans two districts is a real
  -- consequence of the tehsil layer predating the district splits, so any
  -- tehsil level total rolled up to district level is approximate for these.
  RETURN QUERY
  SELECT 'tehsil_straddles_districts',
         'info',
         count(*) || ' tehsils extend more than 5 percent into a second district'
  FROM (
    SELECT t.tehsil_code
    FROM geo.tehsils t
    JOIN geo.districts d
      ON d.province_code = t.province_code
     AND d.geom && t.geom
     AND ST_Area(ST_Intersection(d.geom, t.geom)) > 0.05 * ST_Area(t.geom)
    GROUP BY t.tehsil_code HAVING count(*) > 1
  ) v;

  RETURN QUERY
  SELECT 'province_geometry_loaded',
         CASE WHEN count(*) = 0 THEN 'ok' ELSE 'warn' END,
         count(*) || ' seeded provinces still without geometry'
  FROM geo.provinces WHERE geom IS NULL;
END;
$$ LANGUAGE plpgsql STABLE;
