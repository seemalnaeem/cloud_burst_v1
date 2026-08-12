-- CARI choropleth cache.
--
-- The Analysis view colours whole administrative layers by CARI class, which
-- means scoring every district (188) and every tehsil (553) at a lead. That is
-- far too much zonal work to redo on each panel toggle, so the finished class
-- array for a (feature_kind, cycle, lead) is cached here as one row.
--
-- This is deliberately separate from score.cari, which caches the full per
-- district breakdown behind the detail card. This table holds only what a
-- choropleth needs: the class and percentage per feature, as one JSON payload.
-- One row serves a whole layer, so a colour refresh is a single indexed read.

CREATE TABLE IF NOT EXISTS score.cari_choropleth (
    feature_kind  text        NOT NULL CHECK (feature_kind IN ('district', 'tehsil')),
    creation_time timestamptz NOT NULL,
    lead_hours    integer     NOT NULL,
    -- [{ "key": <join value>, "name": <label>, "cari": <pct>, "classIdx": <0..6> }, ...]
    -- key is the map join field: district_name for districts, tehsil_code for
    -- tehsils, because tehsil names repeat across districts and the code does not.
    payload       jsonb       NOT NULL,
    feature_count integer     NOT NULL,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (feature_kind, creation_time, lead_hours)
);
