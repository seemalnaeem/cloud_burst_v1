-- Extensions and schemas. Runs once, on first boot of an empty volume.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Trigram matching. Advisory press releases name districts inconsistently, and
-- similarity search handles the long tail better than a hand maintained alias
-- table. Also powers the "did you mean" suggestion on a 404.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS geo;    -- boundary geometry
CREATE SCHEMA IF NOT EXISTS obs;    -- observations, historic events
CREATE SCHEMA IF NOT EXISTS wx;     -- forecast cycles, leads, raster catalog
CREATE SCHEMA IF NOT EXISTS score;  -- CARI, hotspot, susceptibility, alerts
CREATE SCHEMA IF NOT EXISTS meta;   -- sources, ingest runs, job log
CREATE SCHEMA IF NOT EXISTS tiles;  -- MVT functions exposed to pg_tileserv
CREATE SCHEMA IF NOT EXISTS stg;    -- ingest staging, contents are disposable

COMMENT ON SCHEMA geo   IS 'Administrative boundary geometry with per zoom generalized copies';
COMMENT ON SCHEMA obs   IS 'Observed and historic events, point geometry';
COMMENT ON SCHEMA wx    IS 'Forecast cycle metadata and the raster catalog';
COMMENT ON SCHEMA score IS 'Scoring model outputs, scores only, no geometry';
COMMENT ON SCHEMA meta  IS 'Provenance: where data came from and when it was loaded';
COMMENT ON SCHEMA tiles IS 'MVT tile functions, one per published layer';
COMMENT ON SCHEMA stg   IS 'Raw ingest staging. Every table here is rewritten by the next ingest and nothing outside the ingest path may read it';

-- ------------------------------------------------------------ text normalizers
-- Defined here rather than in 03_helpers.sql because generated columns in
-- 01_schema.sql reference them, and init files run in filename order.

-- Trim and repair a value coming out of a shapefile. DBF pads every character
-- field to its full width, and the district source additionally carries CR LF
-- pairs inside 17 division values, so a plain btrim is not enough: the carriage
-- return sits in the middle of the padding and survives it.
--
-- Collapsing internal whitespace runs is deliberate. It is a superset of the
-- left and right trim that was asked for, and on this data it changes only the
-- values that contain those embedded newlines.
CREATE OR REPLACE FUNCTION geo.clean_text(t text)
RETURNS text AS $$
  SELECT nullif(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')), '');
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION geo.clean_text(text) IS
  'Shapefile text cleaner: collapse whitespace runs including embedded CR LF, trim, empty becomes NULL.';

-- Fold a name to a comparison key: letters and digits only, upper cased. Used
-- to build stable codes and to look up aliases. Never used as a join key on its
-- own, because folding merges names that are genuinely different.
CREATE OR REPLACE FUNCTION geo.name_key(t text)
RETURNS text AS $$
  SELECT nullif(upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]+', '', 'g')), '');
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION geo.name_key(text) IS
  'Alphanumeric upper cased fold of a name. For code building and alias lookup, never for joining.';
