-- Core schema.
--
-- Two rules run through all of it:
--   1. Geometry is stored in EPSG:4326. Web Mercator conversion happens in the
--      tile function, not in storage.
--   2. Name columns that act as join keys keep the exact source string. See
--      .claude/memory/join-key-discipline.md.

-- ---------------------------------------------------------------- provenance
CREATE TABLE meta.sources (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('vector', 'raster', 'tabular', 'api')),
  origin      text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE meta.sources IS 'Where each dataset came from. Six months later this is the only answer to that question.';

CREATE TABLE meta.ingest_runs (
  id            bigserial PRIMARY KEY,
  source_id     bigint REFERENCES meta.sources(id) ON DELETE SET NULL,
  kind          text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_count bigint,
  pixel_count   bigint,
  duration_ms   integer,
  status        text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'partial', 'failed')),
  message       text,
  started_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_runs_source_ix ON meta.ingest_runs (source_id, started_at DESC);

-- ---------------------------------------------------------------- boundaries
--
-- Geometry is stored and served at full source resolution. There are no
-- generalized copies: an earlier version kept geom_z6 and geom_z9 and the tile
-- functions picked one by zoom, which drew the districts with a 5.5 km
-- tolerance at country scale and made every boundary visibly polygonal. The
-- districts carry 6.8 million vertices, and MVT already snaps coordinates to
-- the 4096 unit tile grid, so the encoding does the only thinning that is
-- actually needed and does it per zoom for free.
--
-- Primary keys are text codes derived from content, not sequence numbers:
--
--   province_code   a fixed three letter code, seeded in 04_admin_reference.sql
--   district_code   province_code || '-' || name_key(district_name)
--   tehsil_code     district_code_src || '-' || name_key(tehsil)
--
-- A content derived code survives a full reload. A bigserial does not: drop and
-- reload the districts and every id shifts, which silently repoints any foreign
-- key or cached client selection at a different district.
--
-- Every source layer also carries measured area and perimeter columns
-- (Shape_Area, Shape_Leng, Area_Sq_Km). They are dropped on ingest. Shape_Area
-- in these files is in square degrees, which is not an area: one degree of
-- longitude is 96 km at Karachi and 88 km at Gilgit, so a southern district is
-- overstated against a northern one by roughly 10 percent. The replacements
-- below are geodesic, computed by casting to geography.

CREATE TABLE geo.national (
  national_code text PRIMARY KEY,
  name          text NOT NULL,
  name_src      text,
  area_km2      double precision,
  perimeter_km  double precision,
  centroid      geometry(Point, 4326),
  geom          geometry(MultiPolygon, 4326) NOT NULL,
  source_id     bigint REFERENCES meta.sources(id),
  ingested_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX national_geom_gix ON geo.national USING GIST (geom);

COMMENT ON TABLE geo.national IS
  'National outlines. The source holds four rows, three of them Pakistan (mainland plus two islands); ingest dissolves them by name so one country is one row.';

CREATE TABLE geo.provinces (
  province_code text PRIMARY KEY,
  province      text NOT NULL UNIQUE,
  province_src  text,
  country       text,
  objectid      bigint,
  area_km2      double precision,
  perimeter_km  double precision,
  centroid      geometry(Point, 4326),
  geom          geometry(MultiPolygon, 4326),
  source_id     bigint REFERENCES meta.sources(id),
  ingested_at   timestamptz
);
CREATE INDEX provinces_geom_gix ON geo.provinces USING GIST (geom);

COMMENT ON COLUMN geo.provinces.province     IS 'Canonical spelling. Every other table denormalizes this one.';
COMMENT ON COLUMN geo.provinces.province_src IS 'Exact string from the provincial shapefile, kept for audit.';

-- The three admin layers spell the same province three ways: the provincial
-- file says "Islamabad", the district file "Federal Capital", the tehsil file
-- "FEDERAL CAPITAL TERRITORY". Resolution happens here, explicitly, once.
-- Nothing in the ingest path is allowed to guess.
CREATE TABLE geo.province_alias (
  alias_key     text PRIMARY KEY,
  province_code text NOT NULL REFERENCES geo.provinces(province_code),
  note          text
);
COMMENT ON TABLE geo.province_alias IS
  'Every province spelling observed in any source, folded through geo.name_key, mapped to one code. An unmapped spelling aborts the ingest rather than inventing a province.';

CREATE TABLE geo.districts (
  district_code text PRIMARY KEY,

  -- Exact source string, whitespace cleaned only. Joins to score.*, alerts and
  -- zonal statistics. Never lowercased or title cased in place.
  district_name text NOT NULL,

  province_code text NOT NULL REFERENCES geo.provinces(province_code),
  province      text NOT NULL,
  province_src  text,
  division      text,
  country       text,
  population    bigint,

  -- Normalized form for fuzzy matching against scraped advisory text.
  -- Generated so it cannot drift. Never join on this.
  district_key  text GENERATED ALWAYS AS (geo.name_key(district_name)) STORED,

  area_km2      double precision,
  perimeter_km  double precision,
  centroid      geometry(Point, 4326),

  geom          geometry(MultiPolygon, 4326) NOT NULL,

  source_id     bigint REFERENCES meta.sources(id),
  ingested_at   timestamptz NOT NULL DEFAULT now(),

  -- Not district_name alone. Poonch exists on both sides of the Line of
  -- Control, so the name is unique only within a province.
  CONSTRAINT districts_prov_name_uk UNIQUE (province_code, district_name)
);
CREATE INDEX districts_geom_gix ON geo.districts USING GIST (geom);
CREATE INDEX districts_key_ix   ON geo.districts (district_key);
CREATE INDEX districts_prov_ix  ON geo.districts (province_code);
CREATE INDEX districts_name_ix  ON geo.districts (district_name);
CREATE INDEX districts_trgm_gix ON geo.districts USING GIN (district_name gin_trgm_ops);

COMMENT ON COLUMN geo.districts.district_code IS
  'Stable primary key, province_code plus the folded name. Survives a full reload, unlike a sequence.';
COMMENT ON COLUMN geo.districts.district_name IS
  'Join key across zonal stats, scores and alerts. Exact source casing and spacing. Unique per province, not globally.';
COMMENT ON COLUMN geo.districts.population IS
  'From the source attribute. NULL for the 21 IIOJK districts, where the source stores a DBF overflow marker rather than a number.';

CREATE TABLE geo.tehsils (
  tehsil_code   text PRIMARY KEY,
  tehsil        text NOT NULL,

  -- The district as the tehsil file spells it, kept verbatim. The tehsil layer
  -- predates the 2018 FATA merger and the Karachi, Chitral and Kohistan splits,
  -- so it names districts the district layer no longer has. Resolution is a
  -- lookup through geo.district_alias, and district_code stays NULL when there
  -- is no honest answer.
  district_src  text NOT NULL,
  district_code text REFERENCES geo.districts(district_code),

  -- How district_code was arrived at, so a questionable parent can be found
  -- later without re-deriving the whole reconciliation.
  --   confirmed  the district the tehsil mostly lies in is also the one its
  --              own district_src names, directly or through a reviewed alias
  --   spatial    the name did not corroborate anything, so the district
  --              sharing the most area with the tehsil was taken
  --   none       unresolved, district_code is NULL
  --
  -- Neither evidence source stands alone here: the name is a label from an
  -- older revision of the boundaries and is wrong wherever a district has been
  -- split since, and pure area misplaces the handful of tehsils that straddle
  -- a boundary. Reasoning in db/ingest/promote_admin.sql.
  link_method   text NOT NULL DEFAULT 'none'
                CHECK (link_method IN ('confirmed', 'spatial', 'none')),

  province_code text NOT NULL REFERENCES geo.provinces(province_code),
  province      text NOT NULL,
  province_src  text,

  area_km2      double precision,
  perimeter_km  double precision,
  centroid      geometry(Point, 4326),

  geom          geometry(MultiPolygon, 4326) NOT NULL,

  source_id     bigint REFERENCES meta.sources(id),
  ingested_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tehsils_src_uk UNIQUE (province_code, district_src, tehsil)
);
CREATE INDEX tehsils_geom_gix  ON geo.tehsils USING GIST (geom);
CREATE INDEX tehsils_dist_ix   ON geo.tehsils (district_code);
CREATE INDEX tehsils_dsrc_ix   ON geo.tehsils (district_src);

COMMENT ON COLUMN geo.tehsils.district_code IS
  'NULL means the tehsil belongs to a district vintage the district layer does not carry. Deliberate: a wrong parent is worse than a missing one.';

-- Explicit, reviewable mapping from a tehsil layer district spelling to a
-- district in the current layer. Populated by 04_admin_reference.sql. There is
-- no fuzzy fallback anywhere in the ingest path: an entry exists or the tehsil
-- stays unlinked and is reported.
CREATE TABLE geo.district_alias (
  province_code text NOT NULL REFERENCES geo.provinces(province_code),
  alias_key     text NOT NULL,
  district_code text NOT NULL REFERENCES geo.districts(district_code),
  note          text,
  PRIMARY KEY (province_code, alias_key)
);
COMMENT ON TABLE geo.district_alias IS
  'Hand reviewed district name reconciliation. Every row states why it exists.';

-- ------------------------------------------------------------ historic events
CREATE TABLE obs.events (
  id                    bigserial PRIMARY KEY,
  sr_no                 integer,
  location_name         text NOT NULL,
  occurrence            text,
  occurred_on           date,
  rainfall_mm           double precision,
  cape_j_kg             double precision,
  relative_humidity_pct double precision,
  precipitable_water_mm double precision,
  vertical_velocity     double precision,
  elevation_m           double precision,
  slope_deg             double precision,
  photo_folder          text,
  photos                text[],
  geom                  geometry(Point, 4326) NOT NULL,
  source_id             bigint REFERENCES meta.sources(id),
  ingested_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_geom_gix ON obs.events USING GIST (geom);
CREATE INDEX events_loc_ix   ON obs.events (location_name);

-- ---------------------------------------------------------------- forecast
CREATE TABLE wx.cycles (
  creation_time   timestamptz PRIMARY KEY,
  model           text NOT NULL DEFAULT 'ECMWF IFS OPER',
  published_leads integer[] NOT NULL DEFAULT '{}',
  discovered_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN wx.cycles.published_leads IS
  'Leads this cycle actually published. A cycle publishes incrementally and may skip a grid point, so never assume the full grid.';

CREATE TABLE wx.raster_catalog (
  id            bigserial PRIMARY KEY,
  band_key      text NOT NULL,
  creation_time timestamptz REFERENCES wx.cycles(creation_time) ON DELETE CASCADE,
  lead_hours    integer,
  path          text NOT NULL,
  unit          text,
  min_value     double precision,
  max_value     double precision,
  nodata        double precision,
  is_static     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX raster_catalog_uix ON wx.raster_catalog (band_key, COALESCE(creation_time, 'epoch'::timestamptz), COALESCE(lead_hours, -9999));
CREATE INDEX raster_catalog_lookup_ix ON wx.raster_catalog (creation_time, lead_hours, band_key);
COMMENT ON TABLE wx.raster_catalog IS
  'Maps a band, cycle and lead to a COG path. The API resolves paths through here so a caller can never pass a filesystem path.';

-- Zonal values per district, the input to every scoring model.
CREATE TABLE wx.district_values (
  creation_time timestamptz NOT NULL,
  lead_hours    integer NOT NULL,
  district_name text NOT NULL,
  values        jsonb NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creation_time, lead_hours, district_name)
);

-- ---------------------------------------------------------------- scores
-- Scores only. No geometry. The old design embedded full polygons here and
-- produced 190 MB responses. See .claude/memory/payload-size-history.md.
CREATE TABLE score.cari (
  creation_time timestamptz NOT NULL,
  lead_hours    integer NOT NULL,
  district_name text NOT NULL,
  matrix        text NOT NULL CHECK (matrix IN ('terrain', 'lowlands')),
  scores        jsonb NOT NULL,
  cas           double precision NOT NULL,
  cari          double precision NOT NULL CHECK (cari BETWEEN 0 AND 100),
  class_idx     smallint NOT NULL CHECK (class_idx BETWEEN 0 AND 6),
  override_applied boolean NOT NULL DEFAULT false,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creation_time, lead_hours, district_name, matrix)
);
CREATE INDEX cari_lookup_ix ON score.cari (creation_time, lead_hours, class_idx DESC);

CREATE TABLE score.susceptibility (
  creation_time timestamptz NOT NULL,
  lead_hours    integer NOT NULL,
  district_name text NOT NULL,
  score         smallint NOT NULL CHECK (score BETWEEN 0 AND 13),
  conditions    jsonb NOT NULL,
  class_idx     smallint NOT NULL CHECK (class_idx BETWEEN 0 AND 4),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creation_time, lead_hours, district_name)
);
CREATE INDEX susc_lookup_ix ON score.susceptibility (creation_time, lead_hours, score DESC);

CREATE TABLE score.hotspots (
  creation_time timestamptz NOT NULL,
  lead_hours    integer NOT NULL,
  district_name text NOT NULL,
  pixel_count   integer NOT NULL DEFAULT 0,
  conditions    jsonb,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creation_time, lead_hours, district_name)
);

CREATE TABLE score.alerts (
  id            bigserial PRIMARY KEY,
  creation_time timestamptz NOT NULL,
  target_date   date NOT NULL,
  lead_hours    integer NOT NULL,
  district_name text NOT NULL,
  province      text,
  class_idx     smallint NOT NULL,
  risk_level    text NOT NULL,
  risk_color    text NOT NULL,
  cari          double precision NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_uix ON score.alerts (creation_time, target_date, district_name);
CREATE INDEX alerts_rank_ix ON score.alerts (target_date, class_idx DESC, district_name);
