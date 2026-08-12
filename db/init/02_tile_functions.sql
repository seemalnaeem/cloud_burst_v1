-- MVT tile functions, one per published layer.
--
-- Two things every one of these gets right, and they are the two that are easy
-- to get wrong:
--
--   1. The bounding box test compares the 4326 column against a transformed
--      envelope. Transforming the column instead would disable the GiST index
--      and turn every tile request into a sequential scan.
--   2. Vertices are dropped only below the tile's own resolution, never above
--      it. See tiles.tolerance below, which is the whole story.

-- How far apart two points must be before a tile can tell them apart.
--
-- A tile is 4096 units across whatever ground distance it covers, so at zoom z
-- one unit is 40075017 / 2^z / 4096 metres. Half of that is used, so the
-- tolerance is always finer than the grid the geometry is about to be snapped
-- to by ST_AsMVTGeom anyway.
--
-- This is not generalization. Points closer together than this cannot be
-- represented in the output at all: they land on the same integer coordinate
-- and are carried as duplicates. At zoom 5 the tolerance is 153 m, at zoom 10
-- it is 4.8 m, and by zoom 14 it is 30 cm, which is finer than any boundary in
-- this dataset was ever surveyed.
--
-- It exists because it has to. The districts carry 6.8 million vertices and
-- Mapbox GL caps a single geometry segment at 65,535, so full resolution at low
-- zoom produced "Max vertices per segment is 65535: bucket requested 74070" and
-- silently dropped geometry. An earlier version of this file simplified at a
-- fixed 5.5 km, which is 36 times coarser than a zoom 5 tile can show and drew
-- the country as a rough polygon. Tying the tolerance to the tile is what makes
-- the difference.
CREATE OR REPLACE FUNCTION tiles.tolerance(z integer)
RETURNS double precision AS $$
  SELECT 40075016.6855785 / power(2, greatest(z, 0)) / 4096 / 2;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION tiles.tolerance(integer) IS
  'Half a tile unit in metres at the given zoom. Simplifying at this tolerance cannot change what a tile is able to display.';

CREATE OR REPLACE FUNCTION tiles.districts(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE bounds geometry; tol double precision; result bytea;
BEGIN
  bounds := ST_TileEnvelope(z, x, y);
  tol := tiles.tolerance(z);

  SELECT ST_AsMVT(c, 'districts', 4096, 'geom') INTO result
  FROM (
    SELECT d.district_code, d.district_name, d.province, d.province_code,
           d.division, d.population, d.area_km2,
           ST_AsMVTGeom(
             ST_CollectionExtract(ST_MakeValid(ST_Simplify(ST_Transform(d.geom, 3857), tol)), 3),
             bounds, 4096, 64, true) AS geom
    FROM geo.districts d
    WHERE d.geom && ST_Transform(bounds, 4326)
  ) c
  WHERE c.geom IS NOT NULL;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION tiles.provinces(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE bounds geometry; tol double precision; result bytea;
BEGIN
  bounds := ST_TileEnvelope(z, x, y);
  tol := tiles.tolerance(z);

  SELECT ST_AsMVT(c, 'provinces', 4096, 'geom') INTO result
  FROM (
    SELECT p.province_code, p.province, p.area_km2,
           ST_AsMVTGeom(
             ST_CollectionExtract(ST_MakeValid(ST_Simplify(ST_Transform(p.geom, 3857), tol)), 3),
             bounds, 4096, 64, true) AS geom
    FROM geo.provinces p
    WHERE p.geom && ST_Transform(bounds, 4326)
  ) c
  WHERE c.geom IS NOT NULL;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION tiles.national(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE bounds geometry; tol double precision; result bytea;
BEGIN
  bounds := ST_TileEnvelope(z, x, y);
  tol := tiles.tolerance(z);

  SELECT ST_AsMVT(c, 'national', 4096, 'geom') INTO result
  FROM (
    SELECT n.national_code, n.name, n.area_km2,
           ST_AsMVTGeom(
             ST_CollectionExtract(ST_MakeValid(ST_Simplify(ST_Transform(n.geom, 3857), tol)), 3),
             bounds, 4096, 64, true) AS geom
    FROM geo.national n
    WHERE n.geom && ST_Transform(bounds, 4326)
  ) c
  WHERE c.geom IS NOT NULL;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION tiles.tehsils(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE bounds geometry; tol double precision; result bytea;
BEGIN
  bounds := ST_TileEnvelope(z, x, y);
  tol := tiles.tolerance(z);

  SELECT ST_AsMVT(c, 'tehsils', 4096, 'geom') INTO result
  FROM (
    SELECT t.tehsil_code, t.tehsil, t.district_src, t.district_code,
           t.province, t.area_km2,
           ST_AsMVTGeom(
             ST_CollectionExtract(ST_MakeValid(ST_Simplify(ST_Transform(t.geom, 3857), tol)), 3),
             bounds, 4096, 64, true) AS geom
    FROM geo.tehsils t
    WHERE t.geom && ST_Transform(bounds, 4326)
  ) c
  WHERE c.geom IS NOT NULL;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

-- The disputed territory is not a separate table. The delivered district layer
-- carries all 22 IIOJK districts with real names under province_code 'IJK', so
-- this is the same layer filtered, kept separate so the map can style and
-- toggle it on its own.
CREATE OR REPLACE FUNCTION tiles.iiojk_districts(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE bounds geometry; tol double precision; result bytea;
BEGIN
  bounds := ST_TileEnvelope(z, x, y);
  tol := tiles.tolerance(z);

  SELECT ST_AsMVT(c, 'iiojk_districts', 4096, 'geom') INTO result
  FROM (
    SELECT d.district_code, d.district_name, d.province, d.area_km2,
           ST_AsMVTGeom(
             ST_CollectionExtract(ST_MakeValid(ST_Simplify(ST_Transform(d.geom, 3857), tol)), 3),
             bounds, 4096, 64, true) AS geom
    FROM geo.districts d
    WHERE d.province_code = 'IJK' AND d.geom && ST_Transform(bounds, 4326)
  ) c
  WHERE c.geom IS NOT NULL;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

-- Points have no vertices to thin. The fifth ST_AsMVT argument names the feature
-- id column, so each point carries its own id in the tile; the map needs that to
-- set the hover and selected feature-state that grows and rings a picked marker.
CREATE OR REPLACE FUNCTION tiles.events(z integer, x integer, y integer)
RETURNS bytea AS $$
DECLARE bounds geometry; result bytea;
BEGIN
  bounds := ST_TileEnvelope(z, x, y);

  SELECT ST_AsMVT(c, 'events', 4096, 'geom', 'id') INTO result
  FROM (
    SELECT e.id, e.location_name, e.occurrence, e.district_name,
           e.rainfall_mm, e.cape_j_kg, e.elevation_m, e.slope_deg,
           ST_AsMVTGeom(ST_Transform(e.geom, 3857), bounds, 4096, 64, true) AS geom
    FROM obs.events e
    WHERE e.geom && ST_Transform(bounds, 4326)
  ) c
  WHERE c.geom IS NOT NULL;

  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE PARALLEL SAFE;

-- pg_tileserv publishes any function it is allowed to execute.
GRANT USAGE ON SCHEMA tiles TO PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tiles TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA tiles GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
