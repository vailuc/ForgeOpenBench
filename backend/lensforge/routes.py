"""
LensForge API routes.

Endpoints:
  GET  /api/v1/lens/devices          — list v4l2 video devices
  GET  /api/v1/lens/status           — status of all 3 slots
  POST /api/v1/lens/{slot}/start     — start a slot
  POST /api/v1/lens/{slot}/stop      — stop a slot
  GET  /api/v1/lens/{slot}/frame     — latest JPEG frame
  POST /api/v1/lens/snapshot         — save snapshot to notes dir
"""

from __future__ import annotations

import base64
import json
import logging
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import Response as FastAPIResponse
from pydantic import BaseModel

from backend.lensforge.camera_service import lens_camera_service, MAX_SLOTS, VALID_FILTERS
from backend.core.config_manager import ConfigManager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/lens", tags=["lensforge"])

_config_manager: ConfigManager | None = None


def set_config_manager(cm: ConfigManager) -> None:
    global _config_manager
    _config_manager = cm


async def _notes_dir() -> Path:
    ws = {}
    if _config_manager:
        ws = await _config_manager.get("workspace") or {}
    project_dir = Path(ws.get("project_dir", "~/Documents/Forge")).expanduser()
    notes_dir = project_dir / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    return notes_dir


class SlotStartPayload(BaseModel):
    device: str | None = None
    filter: str = "orig"
    resolution: str = "640x480"


class AnnotationItem(BaseModel):
    type: str
    x1: float
    y1: float
    x2: float | None = None
    y2: float | None = None
    text: str | None = None
    color: str = "#ff6b00"


class SnapshotPayload(BaseModel):
    pane_id: str
    label: str = ""
    filter: str = "orig"
    image_data_url: str
    annotations: list[AnnotationItem] = []
    note_name: str | None = None


@router.get("/devices")
async def list_devices():
    return lens_camera_service.list_devices()


@router.get("/status")
async def get_status():
    return lens_camera_service.status_all()


@router.post("/{slot}/start")
async def start_slot(slot: int, payload: SlotStartPayload):
    if not 0 <= slot < MAX_SLOTS:
        raise HTTPException(status_code=400, detail=f"Slot must be 0–{MAX_SLOTS - 1}")
    if payload.filter not in VALID_FILTERS:
        raise HTTPException(status_code=400, detail=f"Invalid filter. Choose from {VALID_FILTERS}")
    s = lens_camera_service.slot(slot)
    s.start(device=payload.device, filter_name=payload.filter, resolution=payload.resolution)
    return {"ok": True, "slot": slot, "status": s.status}


@router.post("/{slot}/stop")
async def stop_slot(slot: int):
    if not 0 <= slot < MAX_SLOTS:
        raise HTTPException(status_code=400, detail=f"Slot must be 0–{MAX_SLOTS - 1}")
    lens_camera_service.slot(slot).stop()
    return {"ok": True, "slot": slot}


@router.get("/{slot}/frame")
async def get_frame(slot: int):
    if not 0 <= slot < MAX_SLOTS:
        raise HTTPException(status_code=400, detail=f"Slot must be 0–{MAX_SLOTS - 1}")
    frame = lens_camera_service.slot(slot).get_frame()
    if frame is None:
        raise HTTPException(status_code=503, detail="No frame available")
    return FastAPIResponse(content=frame, media_type="image/jpeg")


@router.post("/snapshot")
async def save_snapshot(payload: SnapshotPayload):
    """Save a LensPane snapshot as a markdown note with embedded image."""
    ts = int(time.time() * 1000)
    note_name = payload.note_name or f"lens-{ts}"

    ann_block = ""
    if payload.annotations:
        ann_json = json.dumps([a.model_dump() for a in payload.annotations], indent=2)
        ann_block = f"\n\n<details><summary>Annotations</summary>\n\n```json\n{ann_json}\n```\n\n</details>"

    ts_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts / 1000))
    content = (
        f"# Lens Capture — {ts_str}\n\n"
        f"**Pane:** {payload.pane_id}  \n"
        f"**Label:** {payload.label or '—'}  \n"
        f"**Filter:** {payload.filter}  \n\n"
        f"![lens-capture]({payload.image_data_url})"
        f"{ann_block}\n"
    )

    d = await _notes_dir()
    safe_name = "".join(c for c in note_name if c.isalnum() or c in "-_ ").strip().replace(" ", "-") or "lens"
    path = d / f"{safe_name}.md"
    path.write_text(content, encoding="utf-8")
    logger.info("[lens] snapshot saved: %s", path)

    return {"ok": True, "note": safe_name, "file": str(path)}
