"""Per pixel raster products: the CAR Index raster and the hotspot mask.

Both grade the same thirteen variables the district scores use, but on every
forecast cell instead of reduced to a boundary. The hard part is not the grading,
which the models already express as pure functions, it is getting thirteen inputs
that live on four different grids onto one grid so a cell means the same thing in
every array. app.geo.align does the warping; this orchestrates it, runs the model
over the stack, writes a COG and catalogues it against the WRFPRS cycle so the
ordinary tile route can serve it.

Generation is on demand and cached, the same shape the choropleth uses: the first
request for a cycle and lead kicks off a background pass and reports "computing",
later requests find the COG catalogued and report "ready". A product whose inputs
are not all catalogued returns NOT_CONFIGURED naming what is missing rather than a
raster that is quietly wrong. The hotspot mask needs precipitation_type_sfc, which
is not ingested yet, so it says so until that source lands.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS

from app.config import settings
from app.db import repositories
from app.geo import align
from app.geo.gdal_tools import to_cog, validate_cog
from app.models import cari as cari_model
from app.models import hotspot as hotspot_model
from app.shared import contracts, timeutil
from app.shared.errors import NotConfigured
from app.shared.logging import logger

# The model the computed rasters are defined on and catalogued against. It is the
# headline model, the finest forecast grid, and the source of most variables, so
# the target grid is its grid and nothing is upsampled to serve it.
GRID_MODEL = "WRFPRS"

# Bound the per generation warp fan-out. Each variable is one gdalwarp; a dozen at
# once would thrash the disk to no benefit.
_SEM = asyncio.Semaphore(4)

# One background generation per (layer, cycle, lead), shared by every poll, so a
# dozen browsers toggling a layer at once trigger a single pass.
_tasks: dict[tuple, asyncio.Task] = {}

_LAYER_BAND = {"cari_raster": "cari_raster", "hotspots": "hotspots"}


def _resampling_for(band_key: str) -> str:
    """How a source collapses onto the coarser grid, a correctness choice.

    Terrain takes max so a cell keeps its steepest, highest ground rather than an
    average that flattens a mountain, matching the max reducer the district scores
    use. The categorical precipitation type takes nearest, because averaging code
    1 and code 5 gives code 3, a different category. Everything else is a
    continuous field and takes bilinear.
    """
    if band_key in ("elevation", "slope"):
        return "max"
    spec = contracts.band(band_key)
    if spec.get("categorical"):
        return "near"
    return "bilinear"


async def _resolve_source(source_band: str, source_model: str | None) -> tuple[str | None, str, object, int | None]:
    """Resolve a variable's catalogue band to (model, band, creation_time, lead-marker).

    A static field (elevation, slope) resolves to no model and no cycle. A forecast
    field with model 'auto' resolves to the first model in the CARI source priority
    that actually catalogues the band, exactly as the district scorer resolves it,
    so wind and vertical velocity fall to GFS and precipitable water to GRAPES. The
    returned creation_time is that model's latest cycle; the lead is filled in by
    the caller at generation time.
    """
    if source_model is None:
        return (None, source_band, None, None)

    if source_model == "auto":
        catalogue = await repositories.catalogued_bands()
        available = {c["model"] for c in catalogue if c["band_key"] == source_band and not c["is_static"] and c["model"]}
        model = next((m for m in cari_model.source_priority() if m in available), None)
    else:
        model = source_model

    if model is None:
        return (None, source_band, None, None)

    cycle = await repositories.latest_cycle(model)
    creation_time = cycle["creation_time"] if cycle else None
    return (model, source_band, creation_time, 0)


async def _grid_for(creation_time, lead: int) -> align.Grid:
    """The target grid, taken from a WRFPRS raster at this cycle.

    The WRFPRS domain is fixed across leads, so any WRFPRS raster for the cycle
    defines the grid; the requested lead is tried first, then any catalogued lead,
    so a lead the map can select always has a grid to align onto.
    """
    ref = await repositories.raster_path("pmd_hourtpe", GRID_MODEL, creation_time, lead)
    if ref is None:
        leads = await repositories.catalogued_leads("pmd_hourtpe", GRID_MODEL, creation_time)
        for lo in leads:
            ref = await repositories.raster_path("pmd_hourtpe", GRID_MODEL, creation_time, lo)
            if ref:
                break
    if ref is None:
        raise NotConfigured("wx.raster_catalog", f"the CAR Index raster, no WRFPRS grid reference for cycle {creation_time}")
    return await asyncio.to_thread(align.grid_from_raster, ref)


async def _load(source_band: str, source_model: str | None, creation_time, lead: int, grid: align.Grid, tmp: Path) -> np.ndarray | None:
    """Resolve one variable's COG and warp it onto the grid, or None if uncatalogued."""
    model, band, model_ct, is_forecast = await _resolve_source(source_band, source_model)
    if is_forecast is None:  # static
        path = await repositories.raster_path(band, None, None, None)
    else:
        path = await repositories.raster_path(band, model, model_ct, lead)
    if not path:
        return None
    resampling = _resampling_for(band)
    async with _SEM:
        return await asyncio.to_thread(
            align.load_aligned, path, grid, tmp, resampling=resampling, tag=f"{band}_{model or 'static'}"
        )


def _write_cog(array: np.ndarray, grid: align.Grid, dst: Path, *, dtype: str, nodata: float | None) -> None:
    """Write an array on the target grid to a validated COG.

    A plain GeoTIFF is written first with the grid's own transform and EPSG:4326,
    then converted to a COG in one pass. TiTiler will happily serve a half written
    file, so the COG lands via a staged move inside to_cog and never mid-write.
    """
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    stage = settings.tmp_dir / f"{dst.stem}_raw.tif"
    profile = {
        "driver": "GTiff",
        "height": grid.height,
        "width": grid.width,
        "count": 1,
        "dtype": dtype,
        "crs": CRS.from_epsg(4326),
        "transform": grid.transform,
    }
    if nodata is not None:
        profile["nodata"] = nodata
    with rasterio.open(stage, "w", **profile) as dst_ds:
        dst_ds.write(array.astype(dtype), 1)
    to_cog(stage, dst, tmp_dir=settings.tmp_dir, float_data=(dtype == "float32"))
    stage.unlink(missing_ok=True)
    if not validate_cog(dst):
        raise RuntimeError(f"{dst} failed COG validation")


def _cog_name(band_key: str, creation_time, lead: int) -> str:
    return f"{band_key}_{creation_time.strftime('%Y%m%d%H')}_t{lead:03d}.tif"


async def _generate_cari(creation_time, lead: int) -> None:
    """Grade the CAR Index on every WRFPRS cell and catalogue the COG."""
    grid = await _grid_for(creation_time, lead)

    specs = cari_model.variable_specs()
    arrays: dict[str, np.ndarray] = {}
    missing: list[str] = []
    tmp = settings.tmp_dir / f"cari_{lead:03d}"
    for spec in specs:
        arr = await _load(spec.get("sourceBand") or spec["band"], spec.get("sourceModel"), creation_time, lead, grid, tmp)
        if arr is None:
            missing.append(f"{spec['key']} ({spec.get('sourceBand') or spec['band']})")
        else:
            arrays[spec["key"]] = arr

    if missing:
        raise NotConfigured("wx.raster_catalog", f"the CAR Index raster, inputs not catalogued for this lead: {sorted(missing)}")

    districts = await repositories.districts_for_matrix()
    shapes = [
        (d["geometry"], 1 if cari_model.terrain_class(d["province"], d["district_name"]) == "terrain" else 0)
        for d in districts
    ]
    terrain_mask = await asyncio.to_thread(align.rasterize_flags, shapes, grid)

    percent = await asyncio.to_thread(cari_model.score_grid, arrays, terrain_mask)

    # Mask the output to the WRFPRS footprint. Cells the reference field does not
    # cover are off the domain, not a genuine zero, so they render as nothing
    # rather than a wash of the palette's lowest class.
    ref = arrays["RF"]
    percent = np.where(np.isnan(ref), np.float32(-9999.0), percent)

    dst = settings.cog_dir / _cog_name("cari_raster", creation_time, lead)
    await asyncio.to_thread(_write_cog, percent, grid, dst, dtype="float32", nodata=-9999.0)
    await repositories.catalog_computed_raster(
        "cari_raster", GRID_MODEL, creation_time, lead, str(dst),
        unit="%", min_value=0, max_value=100, nodata=-9999.0,
    )
    logger.info("cari_raster_generated", lead=lead, path=str(dst))


async def _generate_hotspots(creation_time, lead: int) -> None:
    """AND the thirteen hotspot conditions on every cell and catalogue the mask."""
    grid = await _grid_for(creation_time, lead)

    # The hotspot conditions name canonical bands; map each to the catalogue band
    # and model the CARI variables already resolve, and add the two the mask needs
    # that the index does not carry as its own variables.
    src_of = {spec["band"]: (spec.get("sourceBand") or spec["band"], spec.get("sourceModel")) for spec in cari_model.variable_specs()}
    src_of.setdefault("total_precipitation_sfc_hourly", ("pmd_hourtpe", "auto"))
    src_of["precipitation_type_sfc"] = ("precipitation_type_sfc", "auto")

    arrays: dict[str, np.ndarray] = {}
    missing: list[str] = []
    tmp = settings.tmp_dir / f"hotspots_{lead:03d}"
    for canonical in sorted(hotspot_model.required_bands()):
        source = src_of.get(canonical)
        if source is None:
            missing.append(canonical)
            continue
        arr = await _load(source[0], source[1], creation_time, lead, grid, tmp)
        if arr is None:
            missing.append(f"{canonical} ({source[0]})")
        else:
            arrays[canonical] = arr

    if missing:
        raise NotConfigured("wx.raster_catalog", f"the hotspot mask, conditions not catalogued for this lead: {sorted(missing)}")

    mask = await asyncio.to_thread(hotspot_model.mask, arrays)
    out = mask.astype("uint8")

    dst = settings.cog_dir / _cog_name("hotspots", creation_time, lead)
    # nodata 0 self-masks the raster: only the true cells carry a value and render,
    # everything else is transparent, which is exactly the strict-AND product.
    await asyncio.to_thread(_write_cog, out, grid, dst, dtype="uint8", nodata=0)
    await repositories.catalog_computed_raster(
        "hotspots", GRID_MODEL, creation_time, lead, str(dst),
        unit="", min_value=0, max_value=1, nodata=0,
    )
    logger.info("hotspots_generated", lead=lead, hits=int(out.sum()), path=str(dst))


_GENERATORS = {"cari_raster": _generate_cari, "hotspots": _generate_hotspots}


async def _resolve_cycle(forecast_hours: int) -> tuple[object, int]:
    """The WRFPRS cycle and the lead snapped to what that cycle actually publishes."""
    cycle = await repositories.latest_cycle(GRID_MODEL)
    if cycle is None:
        raise NotConfigured("wx.cycles", f"a computed raster, no {GRID_MODEL} cycle is ingested")
    cycles = [c["creation_time"] for c in await repositories.available_cycles(GRID_MODEL)]
    resolved = timeutil.resolve_cycle(
        forecast_hours, cycle["creation_time"], cycles, list(cycle["published_leads"] or [])
    )
    return resolved.creation_time, resolved.lead_hours


async def compute(layer_id: str, forecast_hours: int) -> dict:
    """Return the computed raster for a lead, generating it in the background if new.

    Mirrors the choropleth: a catalogued product comes back "ready" with the cycle
    and lead its tiles resolve against; an uncatalogued one starts one background
    pass and comes back "computing", which the caller polls until ready. The lead
    is snapped to the WRFPRS grid, and the snapped value is returned so the caller
    points the tiles at the lead that was actually generated.
    """
    if layer_id not in _GENERATORS:
        raise NotConfigured("layers", f"{layer_id!r} is not a computed raster layer")

    creation_time, lead = await _resolve_cycle(forecast_hours)
    band = _LAYER_BAND[layer_id]

    def envelope(status: str) -> dict:
        return {
            "layer": layer_id,
            "status": status,
            "model": GRID_MODEL,
            "creationTime": creation_time,
            "leadHours": lead,
        }

    if await repositories.raster_path(band, GRID_MODEL, creation_time, lead):
        return envelope("ready")

    key = (layer_id, creation_time, lead)
    task = _tasks.get(key)
    if task is not None and task.done():
        _tasks.pop(key, None)
        if task.exception() is not None:
            raise task.exception()
        task = None

    if task is None:
        _tasks[key] = asyncio.create_task(_GENERATORS[layer_id](creation_time, lead))

    return envelope("computing")
