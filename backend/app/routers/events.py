"""Historic cloudburst events.

The point geometry the map draws comes from vector tiles (tiles.events). These
endpoints serve the attribute record behind a clicked point and the images
attached to it. The images are stored in the database as bytes, so this is where
they are streamed back out.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from app.db import repositories
from app.shared.errors import EventNotFound

router = APIRouter()

# Images never change once ingested, so let the browser and the gateway hold them.
_PHOTO_CACHE = "public, max-age=86400, immutable"


@router.get("")
async def list_events() -> dict:
    """Every event, without its images. Small enough to return whole."""
    rows = await repositories.list_events()
    return {"count": len(rows), "events": rows}


@router.get("/geojson")
async def events_geojson() -> dict:
    """Every event as a GeoJSON FeatureCollection, for the map's points source.

    Declared before the /{event_id} route so the word 'geojson' is matched here
    rather than failing to parse as an integer id.
    """
    return await repositories.events_geojson()


@router.get("/{event_id}")
async def get_event(event_id: int) -> dict:
    """One event: its physical values, the district it fell in, and a photo manifest.

    district_name was resolved at ingest by a spatial overlay against the district
    layer, so it is part of the record rather than computed per request.
    """
    event = await repositories.get_event(event_id)
    if event is None:
        raise EventNotFound(event_id)
    return event


@router.get("/{event_id}/photos/{seq}")
async def get_event_photo(event_id: int, seq: int) -> Response:
    """The bytes of one image, in ingest order.

    Returned as the stored content type so the carousel and the full resolution
    modal both read from the same place.
    """
    photo = await repositories.event_photo(event_id, seq)
    if photo is None:
        raise EventNotFound(event_id, what="event photo")
    return Response(
        content=bytes(photo["image"]),
        media_type=photo["mime"],
        headers={"Cache-Control": _PHOTO_CACHE},
    )
