-- Multi-model forecast: a cycle is now identified by (model, creation_time), not
-- creation_time alone, because two models publish a cycle at the same hour
-- (GRAPES and WRFPRS both run 2026081000). The raster catalogue carries the
-- model too, so the same band under two models is two distinct rows.
--
-- Static terrain rows (elevation, slope) are kept: they cost eleven minutes to
-- rebuild and do not belong to any cycle. Only the forecast rows are cleared,
-- to be re-ingested across the four models.
--
-- Idempotent enough to re-run: guards on constraint and index names.

BEGIN;

-- The old single-column FK has to go before the cycles it points at can be
-- truncated and re-keyed.
ALTER TABLE wx.raster_catalog DROP CONSTRAINT IF EXISTS raster_catalog_creation_time_fkey;
ALTER TABLE wx.raster_catalog DROP CONSTRAINT IF EXISTS raster_catalog_cycle_fk;

-- Keep terrain, drop forecast. Then wipe cycles, which are all superseded.
DELETE FROM wx.raster_catalog WHERE NOT is_static;
TRUNCATE wx.cycles CASCADE;

-- Cycles keyed on (model, creation_time).
ALTER TABLE wx.cycles ALTER COLUMN model DROP DEFAULT;
ALTER TABLE wx.cycles DROP CONSTRAINT IF EXISTS cycles_pkey;
ALTER TABLE wx.cycles ADD PRIMARY KEY (model, creation_time);

-- Catalogue carries the model.
ALTER TABLE wx.raster_catalog ADD COLUMN IF NOT EXISTS model text;

DROP INDEX IF EXISTS wx.raster_catalog_uix;
DROP INDEX IF EXISTS wx.raster_catalog_lookup_ix;
CREATE UNIQUE INDEX raster_catalog_uix ON wx.raster_catalog
  (band_key, COALESCE(model, ''), COALESCE(creation_time, 'epoch'::timestamptz), COALESCE(lead_hours, -9999));
CREATE INDEX raster_catalog_lookup_ix ON wx.raster_catalog (model, creation_time, lead_hours, band_key);

-- Composite FK. MATCH SIMPLE (the default) skips the check when any referencing
-- column is NULL, so static rows with model and creation_time NULL are exempt
-- while forecast rows are enforced against a real cycle.
ALTER TABLE wx.raster_catalog ADD CONSTRAINT raster_catalog_cycle_fk
  FOREIGN KEY (model, creation_time) REFERENCES wx.cycles(model, creation_time) ON DELETE CASCADE;

COMMIT;
