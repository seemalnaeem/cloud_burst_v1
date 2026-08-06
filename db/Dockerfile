# PostgreSQL 16 with PostGIS 3.4.
#
# Using the official PostGIS image rather than installing the extension into a
# plain Postgres image. It ships PostGIS, postgis_raster and pgRouting built
# against the exact server version, which avoids the class of failure where the
# extension compiles but the shared library does not match at runtime.
FROM postgis/postgis:16-3.4

# Nothing is installed on top of this image on purpose.
#
# An earlier version added postgresql-16-postgis-3-scripts and gdal-bin here.
# Debian resolves that scripts package to the newest PostGIS in the archive,
# which laid 3.6 era SQL definitions over the 3.4 shared library the image
# ships. CREATE EXTENSION postgis then failed with "could not find function
# lwgeom_neq in postgis-3.so", which reads like a corrupt install rather than a
# version conflict. The image already contains the matching scripts, and
# ogr2ogr runs in cbd-api where the GDAL toolchain lives.

# Files in this directory run in filename order on first boot only, meaning
# only when the data volume is empty. Editing them later has no effect on an
# existing volume, use a migration instead.
COPY init/ /docker-entrypoint-initdb.d/

HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=60s \
  CMD pg_isready -U "${POSTGRES_USER:-cbd_user}" -d "${POSTGRES_DB:-cari}" || exit 1
