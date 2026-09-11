-- Extreme Events cache.
--
-- The Convective Alerts panel offers a per-day "Extreme Events" view: for a
-- chosen PKT forecast day, the peak CARI class across that day's leads, gated by
-- the day's accumulated rainfall, per district or tehsil. Peaking CARI over a
-- day's leads and reducing a day-accumulation raster is far more work than a
-- single lead, so the finished payload for a (feature_kind, cycle, day) is cached
-- here as one row, mirroring score.cari_choropleth but keyed by calendar day
-- rather than lead_hours.

CREATE TABLE IF NOT EXISTS score.cari_extreme (
    feature_kind  text        NOT NULL CHECK (feature_kind IN ('district', 'tehsil')),
    creation_time timestamptz NOT NULL,
    -- PKT calendar date (YYYY-MM-DD) the payload was computed for.
    day_date      text        NOT NULL,
    -- { "features": [{ "key", "name", "classIdx", "dailyRainMm", "extreme" }, ...],
    --   "extremeCount": <int> }
    -- key is the map join field: district_name for districts, tehsil_code for
    -- tehsils, matching score.cari_choropleth.
    payload       jsonb       NOT NULL,
    feature_count integer     NOT NULL,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (feature_kind, creation_time, day_date)
);
