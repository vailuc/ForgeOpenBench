"""
LensForge camera service — up to 3 independent ffmpeg capture slots.

Each slot owns its own ffmpeg process, physical /dev/videoN device, and
JPEG frame cache. Ported from bench-os camera_service.py and extended to
support 3 independent slots instead of one composite grid.

Slot lifecycle:
  slot.start(device, filter, resolution) → ffmpeg → MJPEG stdout → frame cache
  slot.stop()                            → terminate ffmpeg, clear cache
  slot.get_frame()                       → latest cached JPEG bytes or None
"""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_SLOTS = 3
MAX_BUFFER = 4 * 1024 * 1024  # 4 MiB safety cap

VALID_FILTERS = {"orig", "edge", "inv", "bw", "sharp"}

FILTER_CHAINS: dict[str, str] = {
    "orig":  "format=yuvj420p",
    "edge":  "edgedetect=mode=colormix:high=0,format=yuvj420p",
    "inv":   "negate,format=yuvj420p",
    "bw":    "hue=s=0,format=yuvj420p",
    "sharp": "unsharp=5:5:1.5:5:5:0,format=yuvj420p",
}

DEFAULT_RESOLUTION = "640x480"


def _framerate_for_resolution(resolution: str) -> str:
    try:
        w, h = map(int, resolution.split("x"))
        return "30" if w * h <= 1024 * 768 else "15"
    except ValueError:
        return "30"


def _parse_jpeg_frames(buffer: bytes) -> tuple[list[bytes], bytes]:
    frames: list[bytes] = []
    while True:
        soi = buffer.find(b"\xff\xd8")
        if soi == -1:
            return frames, b""
        eoi = buffer.find(b"\xff\xd9", soi + 2)
        if eoi == -1:
            return frames, buffer[soi:]
        frames.append(buffer[soi: eoi + 2])
        buffer = buffer[eoi + 2:]


def _list_v4l2_devices() -> list[dict]:
    """Return list of {device, name} for all /dev/video* nodes."""
    devices = []
    for p in sorted(Path("/dev").glob("video*")):
        name = p.name
        try:
            result = subprocess.run(
                ["v4l2-ctl", "-d", str(p), "--info"],
                capture_output=True, text=True, timeout=2,
            )
            for line in result.stdout.splitlines():
                if "Card type" in line:
                    name = line.split(":", 1)[1].strip()
                    break
        except Exception:
            pass
        devices.append({"device": str(p), "name": name})
    return devices


class CameraSlot:
    """One camera capture slot — one ffmpeg process, one device."""

    def __init__(self, slot_id: int):
        self.slot_id = slot_id
        self._proc: subprocess.Popen | None = None
        self._device: str = f"/dev/video{slot_id}"
        self._filter: str = "orig"
        self._resolution: str = DEFAULT_RESOLUTION
        self._frame: bytes | None = None
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._stop_flag = threading.Event()
        self._started_at: float | None = None

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def status(self) -> dict:
        with self._lock:
            have_frame = self._frame is not None
        return {
            "slot": self.slot_id,
            "running": self.is_running,
            "device": self._device,
            "filter": self._filter,
            "resolution": self._resolution,
            "started_at": self._started_at,
            "pid": self._proc.pid if self.is_running else None,
            "have_frame": have_frame,
        }

    def get_frame(self) -> bytes | None:
        with self._lock:
            return self._frame

    def start(self, device: str | None = None, filter_name: str = "orig", resolution: str = DEFAULT_RESOLUTION) -> None:
        if self.is_running:
            self.stop()

        if device:
            self._device = device
        self._filter = filter_name if filter_name in VALID_FILTERS else "orig"
        self._resolution = resolution

        self._stop_flag.clear()
        with self._lock:
            self._frame = None

        time.sleep(0.2)  # let v4l2 device release after previous stop

        cmd = self._build_cmd()
        logger.info("[lens slot %d] starting: %s", self.slot_id, " ".join(cmd))
        self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()
        self._started_at = time.time()

    def stop(self) -> None:
        if not self.is_running and self._reader is None:
            return
        self._stop_flag.set()
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()
        self._proc = None
        self._started_at = None
        if self._reader:
            self._reader.join(timeout=2)
        self._reader = None
        with self._lock:
            self._frame = None
        logger.info("[lens slot %d] stopped", self.slot_id)

    def _reader_loop(self) -> None:
        if not self._proc or not self._proc.stdout:
            return
        stdout = self._proc.stdout
        try:
            buffer = b""
            while not self._stop_flag.is_set():
                chunk = stdout.read(65536)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > MAX_BUFFER:
                    buffer = buffer[-MAX_BUFFER:]
                frames, buffer = _parse_jpeg_frames(buffer)
                if frames:
                    with self._lock:
                        self._frame = frames[-1]
        except Exception as exc:
            logger.warning("[lens slot %d] reader error: %s", self.slot_id, exc)

    def _build_cmd(self) -> list[str]:
        res = self._resolution
        fps = _framerate_for_resolution(res)
        chain = FILTER_CHAINS.get(self._filter, FILTER_CHAINS["orig"])
        return [
            "ffmpeg",
            "-nostats", "-loglevel", "error",
            "-f", "v4l2", "-input_format", "mjpeg",
            "-video_size", res, "-framerate", fps,
            "-i", self._device,
            "-vf", chain,
            "-f", "mjpeg", "-q:v", "4", "-r", fps,
            "pipe:1",
        ]


class LensCameraService:
    """Manages up to MAX_SLOTS independent camera slots."""

    def __init__(self):
        self._slots: list[CameraSlot] = [CameraSlot(i) for i in range(MAX_SLOTS)]

    def list_devices(self) -> list[dict]:
        return _list_v4l2_devices()

    def slot(self, idx: int) -> CameraSlot:
        if not 0 <= idx < MAX_SLOTS:
            raise ValueError(f"Slot {idx} out of range (0-{MAX_SLOTS - 1})")
        return self._slots[idx]

    def status_all(self) -> list[dict]:
        return [s.status for s in self._slots]

    def stop_all(self) -> None:
        for s in self._slots:
            s.stop()


lens_camera_service = LensCameraService()
