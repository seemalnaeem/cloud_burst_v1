# FastAPI plus the full geoprocessing toolchain.
#
# Building on the official OSGeo GDAL image rather than pip installing GDAL on
# top of a plain Python base. That image ships GDAL 3.8, PROJ 9 and the osgeo
# Python bindings already compiled against each other. Installing the GDAL pip
# package against a mismatched system library is a reliable way to lose a day
# to import errors that look like something else.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.4

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-pip python3-dev \
      libpq-dev postgresql-client \
      build-essential curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before application code, so a source edit does not invalidate
# the install layer.
COPY requirements.txt .
# The GDAL image is Ubuntu 22.04, whose pip predates --break-system-packages and
# rejects it outright. 22.04 also ships no EXTERNALLY-MANAGED marker, so there is
# nothing to break out of. Upgrading pip first keeps the behaviour predictable if
# the base image ever moves to a release that does enforce PEP 668.
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
 && python3 -m pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Where COGs and raw sources live. Bind mounted in compose.
RUN mkdir -p /data/raw /data/cog /data/tmp

# GDAL tuning. GDAL_DISABLE_READDIR_ON_OPEN matters most: without it GDAL
# lists the entire directory looking for sidecar files on every single open,
# which is painful once /data/cog holds a few hundred rasters.
ENV GDAL_CACHEMAX=512 \
    GDAL_NUM_THREADS=ALL_CPUS \
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif,.tiff,.vrt,.json \
    PYTHONPATH=/app

EXPOSE 3091

# Bind 0.0.0.0, not 127.0.0.1. A process on loopback inside a container is
# unreachable from outside it.
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3091", "--reload"]
