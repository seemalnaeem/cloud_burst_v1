"""Settings, all from environment. Nothing here has a hard coded host."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Service
    api_port: int = 3091
    log_level: str = "info"
    tz: str = "Asia/Karachi"

    # Database. Host is a compose service name, never an address. Port 5545
    # inside the container as well as outside.
    database_url: str = "postgresql://cbd_user:postgres@cbd-db:5545/cari"
    pg_pool_min: int = 2
    pg_pool_max: int = 10

    # Paths
    data_dir: Path = Path("/data")
    cog_dir: Path = Path("/data/cog")
    raw_dir: Path = Path("/data/raw")
    tmp_dir: Path = Path("/data/tmp")
    contracts_dir: Path = Path("/shared/contracts")

    # Bounds heavy raster work so the event loop and the CPU both survive a
    # burst of requests. Over the limit returns 503 rather than queueing without
    # bound.
    max_concurrent_jobs: int = 4
    job_acquire_timeout_s: int = 45

    # Upstreams.
    #
    # Every one is anonymous HTTP or anonymous S3. There is no field here for an
    # API key, a token or a service account, and adding one is a project rule
    # violation rather than a config change. Google Earth Engine and GeoServer
    # are both ruled out, see OPEN_DATA_SOURCES.md.
    upstream_gfs_base: str = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
    upstream_gfs_filter: str = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
    upstream_ecmwf_opendata: str = "https://data.ecmwf.int/forecasts"
    upstream_dem_base: str = "https://copernicus-dem-30m.s3.amazonaws.com"

    # Blank means not wired yet, and the route returns 501 rather than guessing.
    upstream_pmd_radar_base: str = ""
    upstream_pmd_press_base: str = ""

    upstream_user_agent: str = "Mozilla/5.0 (compatible; CloudBurstDev/1.0)"
    upstream_timeout_s: int = 30

    # Pakistan bounding box, used to clip at the source. A global GFS file is
    # around 500 MB, clipped to this it is a few megabytes.
    aoi_west: float = 59.0
    aoi_south: float = 22.0
    aoi_east: float = 79.0
    aoi_north: float = 38.0

    @property
    def aoi(self) -> tuple[float, float, float, float]:
        return (self.aoi_west, self.aoi_south, self.aoi_east, self.aoi_north)

    @property
    def asyncpg_dsn(self) -> str:
        """asyncpg wants a plain postgresql:// DSN with no driver suffix."""
        return self.database_url.replace("postgresql+asyncpg://", "postgresql://")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
