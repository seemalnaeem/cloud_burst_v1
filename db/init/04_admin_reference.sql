-- Administrative reference data.
--
-- Everything here is a decision rather than an observation, which is why it is
-- version controlled SQL and not something the ingest script infers. Three
-- kinds of decision live in this file:
--
--   1. The canonical province list and its codes.
--   2. Every province spelling seen in any source, mapped to one of those codes.
--   3. Corrections to individual source records, each with a stated reason.
--
-- Geometry is not seeded. The provinces rows exist so that province_code is a
-- real foreign key from the first ingest onward; the ingest fills in geom,
-- area and the source spelling when the provincial layer loads.

-- ------------------------------------------------------------ canonical list
INSERT INTO geo.provinces (province_code, province, country) VALUES
  ('AJK', 'Azad Kashmir',                              'Pakistan'),
  ('BAL', 'Balochistan',                               'Pakistan'),
  ('GBT', 'Gilgit Baltistan',                          'Pakistan'),
  ('ICT', 'Islamabad',                                 'Pakistan'),
  ('KPK', 'Khyber Pakhtunkhwa',                        'Pakistan'),
  ('PJB', 'Punjab',                                    'Pakistan'),
  ('SND', 'Sindh',                                     'Pakistan'),
  ('IJK', 'Indian Illegally Occupied Jammu & Kashmir', NULL);

-- ------------------------------------------------------------------- aliases
-- Keys are geo.name_key() folds: letters and digits, upper cased. The three
-- admin layers disagree on Islamabad and on the disputed territory, and the
-- tehsil layer upper cases everything, so every observed form is listed.
INSERT INTO geo.province_alias (alias_key, province_code, note) VALUES
  ('AZADKASHMIR',       'AJK', 'district and provincial layers'),
  ('AZADJAMMUKASHMIR',  'AJK', 'common long form'),
  ('AJK',               'AJK', 'common abbreviation'),

  ('BALOCHISTAN',       'BAL', 'all three layers'),
  ('BALUCHISTAN',       'BAL', 'older transliteration'),

  ('GILGITBALTISTAN',   'GBT', 'all three layers'),
  ('GB',                'GBT', 'common abbreviation'),

  ('ISLAMABAD',         'ICT', 'provincial layer'),
  ('FEDERALCAPITAL',    'ICT', 'district layer spelling'),
  ('FEDERALCAPITALTERRITORY', 'ICT', 'tehsil layer spelling'),
  ('ISLAMABADCAPITALTERRITORY', 'ICT', 'official long form'),

  ('KHYBERPAKHTUNKHWA', 'KPK', 'all three layers'),
  ('KPK',               'KPK', 'common abbreviation'),
  ('KP',                'KPK', 'common abbreviation'),
  ('NWFP',              'KPK', 'pre 2010 name, appears in older catalogues'),

  ('PUNJAB',            'PJB', 'all three layers'),
  ('SINDH',             'SND', 'all three layers'),

  ('INDIANILLEGALLYOCCUPIEDJAMMUKASHMIR', 'IJK', 'provincial layer, ampersand folded out'),
  ('IOJK',              'IJK', 'district layer spelling'),
  ('IIOJK',             'IJK', 'spelling used in DATA_SOURCES.md and the CARI contract'),
  ('JAMMUKASHMIR',      'IJK', 'short form'),
  ('JAMMUANDKASHMIR',   'IJK', 'short form');

-- -------------------------------------------------------------- corrections
-- A source record that is wrong, with the correction and the reason. Applied
-- during ingest by matching the source layer's own identifier, so the original
-- shapefile is never edited and the change is auditable.
CREATE TABLE geo.source_correction (
  layer      text NOT NULL,
  src_id     text NOT NULL,
  field      text NOT NULL,
  old_value  text,
  new_value  text,
  reason     text NOT NULL,
  PRIMARY KEY (layer, src_id, field)
);

COMMENT ON TABLE geo.source_correction IS
  'Per record fixes to the delivered shapefiles. The ingest applies these and reports how many matched, so a correction that stops matching after a data refresh is visible rather than silent.';

-- District_Boundary row id 187 carries the name Poonch, which would make three
-- Poonch rows in a layer that should have one per side of the Line of Control.
-- Its numeric attributes are DBF overflow markers, so the record was already
-- damaged. Azad Kashmir has ten districts and the layer holds ten AJK rows, but
-- Bagh is absent while Poonch is duplicated, and the tehsil layer carries BAGH
-- with its two tehsils. Confirmed by the project owner.
INSERT INTO geo.source_correction (layer, src_id, field, old_value, new_value, reason) VALUES
  ('districts', '187', 'districts', 'Poonch', 'Bagh',
   'Row is Bagh district, mislabelled Poonch in the source. Attribute row damaged (objectid and population are DBF overflow markers). Confirmed by the project owner.');
