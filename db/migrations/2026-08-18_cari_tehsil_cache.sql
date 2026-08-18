-- Per tehsil CARI cache.
--
-- The tehsil analog of score.cari. The detail card scores one clicked feature
-- over its full resolution geometry, which for a tehsil is the same 13-raster
-- zonal pass a district runs. Until now a tehsil was rescored on every click,
-- because there was nowhere to keep the result.
--
-- The whole-layer choropleth pass already computes every tehsil's full CARI on
-- its way to the class array; this table lets that pass keep the full result so
-- a click reads one indexed row instead of rescoring. Keyed by tehsil_code, the
-- unique join field, because tehsil names repeat across districts.
--
-- Only the automatic terrain matrix is ever written here (the choropleth is the
-- only writer and it always scores automatically), so a lookup by code alone is
-- unambiguous. The matrix column is kept for parity with score.cari and so an
-- admin override path can be added later without a schema change.

CREATE TABLE IF NOT EXISTS score.cari_tehsil (
  creation_time timestamptz NOT NULL,
  lead_hours    integer NOT NULL,
  tehsil_code   text NOT NULL,
  matrix        text NOT NULL CHECK (matrix IN ('terrain', 'lowlands')),
  scores        jsonb NOT NULL,
  cas           double precision NOT NULL,
  cari          double precision NOT NULL CHECK (cari BETWEEN 0 AND 100),
  class_idx     smallint NOT NULL CHECK (class_idx BETWEEN 0 AND 6),
  override_applied boolean NOT NULL DEFAULT false,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creation_time, lead_hours, tehsil_code, matrix)
);
CREATE INDEX IF NOT EXISTS cari_tehsil_lookup_ix
  ON score.cari_tehsil (creation_time, lead_hours, tehsil_code);
