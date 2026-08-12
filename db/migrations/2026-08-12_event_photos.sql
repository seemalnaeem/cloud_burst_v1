-- Historic events: photo table and the spatial district column.
--
-- obs.events already existed as the tabular record. This adds the second table
-- the images live in, and a district_name column filled at ingest by a spatial
-- overlay against geo.districts. Idempotent, so it is safe to run against a live
-- database that may already carry either change.

ALTER TABLE obs.events ADD COLUMN IF NOT EXISTS district_name text;

CREATE TABLE IF NOT EXISTS obs.event_photos (
  id          bigserial PRIMARY KEY,
  event_id    bigint NOT NULL REFERENCES obs.events(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  filename    text NOT NULL,
  mime        text NOT NULL DEFAULT 'image/png',
  width       integer,
  height      integer,
  byte_size   integer NOT NULL,
  image       bytea NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, seq)
);
CREATE INDEX IF NOT EXISTS event_photos_event_ix ON obs.event_photos (event_id, seq);
