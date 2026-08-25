-- Cycle completeness, for graceful degradation when a live source is down.
--
-- Until now the ingest deleted a model's whole catalogue before fetching, so a
-- run that failed or was interrupted left the model blank and there was nothing
-- to fall back to. The ingest is being made non-destructive (write the new cycle,
-- prune old ones only after success), which means the catalogue can hold several
-- cycles at once and a reader must know which of them is a finished run rather
-- than a half-written one.
--
-- `complete` is set true by the ingest only when a model's run reaches the end
-- without error. Cycle selection prefers the newest complete cycle, so a partial
-- newest cycle never shadows a good older one. See shared/contracts/resilience.json.

ALTER TABLE wx.cycles
  ADD COLUMN IF NOT EXISTS complete boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN wx.cycles.complete IS
  'True once the ingest finished this model''s run cleanly. Readers prefer the newest complete cycle so a partial run cannot shadow a good one.';

-- Backfill: the only cycles that currently carry catalogue rows are the latest
-- per model (the old delete-then-insert kept just one). Mark any cycle that holds
-- the largest band count seen for its model as complete, so the fallback has a
-- known-good starting point before the next clean ingest runs.
WITH counts AS (
  SELECT model, creation_time, count(DISTINCT band_key) AS bands
  FROM wx.raster_catalog
  WHERE model IS NOT NULL
  GROUP BY model, creation_time
),
peak AS (
  SELECT model, max(bands) AS bands FROM counts GROUP BY model
)
UPDATE wx.cycles c
SET complete = true
FROM counts n
JOIN peak p ON p.model = n.model AND p.bands = n.bands
WHERE c.model = n.model AND c.creation_time = n.creation_time;
