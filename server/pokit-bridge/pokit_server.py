#!/usr/bin/env python3
"""
Pokit Pro BLE Bridge - Native BLE proxy for Linux/RPi

Bypasss Web Bluetooth notification batching (135-150ms gaps) by using
bleak (native BlueZ) and forwarding raw GATT bytes over WebSocket.

Architecture: Dumb pipe. Does NOT parse Pokit protocol bytes.
Frontend keeps all encode/decode logic (ByteReader, ByteWriter, etc.)

Target: Raspberry Pi 4/5 with Arch Linux + BlueZ 5.66+
"""

import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

import websockets
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError, BleakGATTProtocolError
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress benign websockets handshake errors from port probes / browser preconnects
class _WsHandshakeFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return "did not receive a valid HTTP request" not in msg and "opening handshake failed" not in msg

logging.getLogger("websockets.server").addFilter(_WsHandshakeFilter())
# Also suppress routine connection open/close INFO spam from browser preconnects
logging.getLogger("websockets.server").setLevel(logging.WARNING)

# ── Pokit UUIDs (match frontend src/pokit/uuids.ts) ──────────────────────────
STATUS_SERVICES = {
    "pokit_meter": "57d3a771-267c-4394-8872-78223e92aec4",
    "pokit_pro":   "57d3a771-267c-4394-8872-78223e92aec5",
}
DSO_SERVICE      = "1569801e-1425-4a7a-b617-a4f4ed719de6"
MULTIMETER_SERV  = "e7481d2f-5781-442e-bb9a-fd4e3441dadc"
LOGGER_SERV      = "a5ff3566-1fd8-4e10-8362-590a578a4121"
DEVICE_INFO_SERV = "0000180a-0000-1000-8000-00805f9b34fb"
BATTERY_SERV     = "0000180f-0000-1000-8000-00805f9b34fb"

ALL_SERVICES = [
    STATUS_SERVICES["pokit_meter"],
    STATUS_SERVICES["pokit_pro"],
    DSO_SERVICE,
    MULTIMETER_SERV,
    LOGGER_SERV,
    DEVICE_INFO_SERV,
    BATTERY_SERV,
]

# ── Config ──────────────────────────────────────────────────────────────────
CONFIG_DIR = Path.home() / ".config" / "pokit-pro"
CONFIG_FILE = CONFIG_DIR / "last_device.json"

# ── Settings Persistence ──────────────────────────────────────────────────────
def get_settings_path() -> Path:
    """Single source of truth for settings file path."""
    if os.environ.get("APP_SETTINGS"):
        return Path(os.environ["APP_SETTINGS"])
    return Path.home() / ".config" / "pokit-pro" / "settings.json"

SETTINGS_FILE = get_settings_path()

DEFAULT_SETTINGS = {
    "version": 1,
    "lastModified": 0,
    "ui": {
        "theme": "dark",
        "accent": "blue",
        "startupTab": "meter",
        "connectionMode": "bridge",
        "bridgeUrl": "ws://localhost:8765",
        "sidebarCollapsed": False
    },
    "plugins": {
        "dso": {"version": 1, "defaultWindowMs": 50, "defaultMode": "one-shot", "performanceHints": True},
        "meter": {"version": 1, "autoRange": True, "operationalWarnings": True},
        "logger": {"version": 1, "defaultSampleRate": 10, "defaultDuration": 60},
        "device": {"version": 1, "showAdvanced": False}
    }
}

class SettingsManager:
    """Manages persistent settings with atomic file operations."""
    
    def __init__(self, settings_path: Path = None):
        self.settings_path = settings_path or get_settings_path()
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        self._settings = self._load()
    
    def _load(self) -> dict:
        """Load settings from disk, merging with defaults."""
        if not self.settings_path.exists():
            logger.info(f"[Settings] No settings file found, using defaults")
            return DEFAULT_SETTINGS.copy()
        try:
            with open(self.settings_path, 'r') as f:
                loaded = json.load(f)
                # Merge with defaults for any missing keys
                merged = self._deep_merge(DEFAULT_SETTINGS.copy(), loaded)
                logger.info(f"[Settings] Loaded from {self.settings_path}")
                return merged
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"[Settings] Failed to load: {e}, using defaults")
            return DEFAULT_SETTINGS.copy()
    
    def _save(self) -> None:
        """Atomic write: tmp → flush → fsync → replace."""
        self._settings["lastModified"] = int(time.time())
        tmp_path = f"{self.settings_path}.tmp"
        try:
            with open(tmp_path, 'w') as f:
                json.dump(self._settings, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.settings_path)
            logger.info(f"[Settings] Saved to {self.settings_path}")
        except IOError as e:
            logger.error(f"[Settings] Failed to save: {e}")
            raise
    
    def _deep_merge(self, base: dict, update: dict) -> dict:
        """Recursive merge, preserving nested structures."""
        for key, value in update.items():
            if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                base[key] = self._deep_merge(base[key], value)
            else:
                base[key] = value
        return base
    
    def get(self) -> dict:
        """Return copy of current settings."""
        return self._settings.copy()
    
    def patch(self, patch: dict) -> dict:
        """Apply shallow merge patch and save."""
        self._settings = self._deep_merge(self._settings, patch)
        self._save()
        return self._settings.copy()

MAX_RECONNECT_RETRIES = 10
RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000]
WS_HOST = os.environ.get("POKIT_WS_HOST", "0.0.0.0")
WS_PORT = int(os.environ.get("POKIT_WS_PORT", "8765"))


# ── Connection State ────────────────────────────────────────────────────────
class ConnectionState:
    DISCONNECTED = "disconnected"
    SCANNING     = "scanning"
    CONNECTING   = "connecting"
    CONNECTED    = "connected"
    RECONNECTING = "reconnecting"


# ── PokitBridgeServer ───────────────────────────────────────────────────────
class PokitBridgeServer:
    """
    Owns the bleak client lifecycle:
      • Scan → connect → persist MAC
      • Auto-reconnect on disconnect
      • Subscribe/unsubscribe characteristics
      • Forward raw GATT bytes (base64) over WebSocket
    """

    def __init__(self):
        self.client: Optional[BleakClient] = None
        self.device_info: Optional[dict] = None   # {name, address}
        self.state = ConnectionState.DISCONNECTED
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.auto_reconnect = False
        self.retry_count = 0
        self._reconnect_task: Optional[asyncio.Task] = None
        self._notification_queue: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._consumer_task: Optional[asyncio.Task] = None
        self._ws_clients: set[websockets.WebSocketServerProtocol] = set()
        self._active_subscriptions: dict[str, str] = {}   # char_uuid -> service_uuid
        self._req_counter = 0
        self._last_scan_devices: list[dict] = []
        self._last_scan_ble_devices: dict[str, BLEDevice] = {}  # address -> BLEDevice from last scan
        self._notify_log_ts: dict[str, float] = {}  # char_uuid -> last log time
        self._last_scan_time: float = 0.0
        self._keepalive_task: Optional[asyncio.Task] = None
        self._connect_lock = asyncio.Lock()
        self._gatt_lock = asyncio.Lock()

        # Settings manager for persistent user preferences
        self.settings_manager = SettingsManager()

    # ── Config persistence ──────────────────────────────────────────────────
    def _load_config(self) -> Optional[dict]:
        if CONFIG_FILE.exists():
            try:
                return json.loads(CONFIG_FILE.read_text())
            except json.JSONDecodeError:
                logger.warning("Corrupt config file, ignoring")
        return None

    def _save_config(self, address: str, name: str) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps({"address": address, "name": name, "auto_reconnect": self.auto_reconnect}))

    # ── State broadcast ─────────────────────────────────────────────────────
    async def _broadcast_state(self) -> None:
        payload = {
            "type": "ble_state",
            "state": self.state,
            "address": self.device_info.get("address") if self.device_info else None,
            "name": self.device_info.get("name") if self.device_info else None,
            "retry_count": self.retry_count,
        }
        await self._broadcast_ws(payload)

    # -- Safe send helper (ignores closed connections) --
    async def _safe_send(self, ws, payload: dict) -> None:
        try:
            await ws.send(json.dumps(payload))
        except websockets.ConnectionClosed:
            pass

    async def _broadcast_ws(self, payload: dict) -> None:
        """Send JSON to all connected WebSocket clients."""
        if not self._ws_clients:
            return
        message = json.dumps(payload)
        dead = set()
        # Iterate over a snapshot to avoid RuntimeError if another coroutine
        # modifies _ws_clients while we are yielding on ws.send().
        for ws in list(self._ws_clients):
            try:
                await ws.send(message)
            except websockets.ConnectionClosed:
                dead.add(ws)
            except Exception:
                # Any other send error (e.g., InvalidState) means this client is dead
                dead.add(ws)
        if dead:
            logger.debug(f"Removed {len(dead)} dead WebSocket client(s)")
        self._ws_clients -= dead

    # ── BLE notification callback (MUST be non-blocking) ────────────────────
    def _on_notification(self, sender: Any, data: bytearray) -> None:
        """
        bleak callback — runs on BlueZ thread.
        Schedule enqueue on the asyncio event loop; never do I/O here.
        """
        char_uuid = str(sender.uuid)
        now = time.time()
        last = self._notify_log_ts.get(char_uuid, 0)
        if now - last >= 5.0:
            self._notify_log_ts[char_uuid] = now
            logger.info(f"[Notify] {char_uuid[:8]}… len={len(data)}")
        # Periodic hex dump of reading char to verify data is changing
        last_hex = getattr(self, "_notify_hex_ts", {})
        if now - last_hex.get(char_uuid, 0) >= 30.0:
            if not hasattr(self, "_notify_hex_ts"):
                self._notify_hex_ts = {}
            self._notify_hex_ts[char_uuid] = now
            logger.info(f"[NotifyHex] {char_uuid[:8]}… {data.hex()}")
        raw = bytes(data)
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._notification_queue.put_nowait, (char_uuid, raw))
        else:
            # Fallback before first WS client connects (shouldn't happen in practice)
            try:
                self._notification_queue.put_nowait((char_uuid, raw))
            except asyncio.QueueFull:
                logger.warning("Notification queue full, dropping oldest packet")
                try:
                    self._notification_queue.get_nowait()
                    self._notification_queue.put_nowait((char_uuid, raw))
                except asyncio.QueueEmpty:
                    pass

    # ── BLE disconnected callback ───────────────────────────────────────────────────────────────────────────
    def _on_disconnected(self, client: BleakClient) -> None:
        """
        bleak callback — called when the BLE link drops unexpectedly.
        Schedules async cleanup and auto-reconnect.
        """
        logger.warning(f"BLE device disconnected: {client.address}")
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._handle_disconnected(client.address))
        except RuntimeError:
            pass  # no running loop, can’t do anything

    async def _handle_disconnected(self, address: str) -> None:
        """Async cleanup after BLE disconnection."""
        self.client = None
        self._stop_keepalive()
        self.state = ConnectionState.DISCONNECTED
        await self._broadcast_state()
        if self.auto_reconnect and address:
            self._start_reconnect(address)

    # ── Keepalive (prevents BlueZ supervision timeout) ────────────────────
    async def _keepalive_loop(self) -> None:
        """Periodically read a harmless characteristic to keep the BLE link alive.
        Skipped when subscriptions are active — notifications already prevent idle timeout."""
        await asyncio.sleep(10)  # First keepalive soon after connect
        while self.client and self.client.is_connected:
            try:
                # If subscriptions are active, notifications keep the link alive;
                # skip keepalive reads to avoid stressing Pokit firmware with
                # concurrent read + notify on the same characteristic.
                if self._active_subscriptions:
                    await asyncio.sleep(45)
                    continue
                # Read Device Name from Device Info service — harmless, no side effects
                async with self._gatt_lock:
                    if self.client and self.client.is_connected:
                        await self.client.read_gatt_char("00002a00-0000-1000-8000-00805f9b34fb")
                logger.debug("Keepalive OK")
            except Exception:
                # Read failed; _on_disconnected will handle cleanup
                pass
            await asyncio.sleep(45)

    def _start_keepalive(self) -> None:
        if self._keepalive_task and not self._keepalive_task.done():
            return
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    def _stop_keepalive(self) -> None:
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
        self._keepalive_task = None

    # ── Notification consumer (runs in asyncio loop) ────────────────────────
    async def _consume_notifications(self) -> None:
        """
        Pull from queue, forward to WebSocket clients.
        This is the slow path — async I/O is safe here.
        """
        logger.info("Notification consumer started")
        last_qlog = 0.0
        while True:
            try:
                char_uuid, raw = await self._notification_queue.get()
                now = time.time()
                if now - last_qlog >= 30.0:
                    last_qlog = now
                    qsize = self._notification_queue.qsize()
                    logger.info(f"[Consumer] queue depth={qsize}, clients={len(self._ws_clients)}")
                payload = {
                    "type": "gatt_notification",
                    "characteristic": char_uuid,
                    "data": base64.b64encode(raw).decode("ascii"),
                }
                await self._broadcast_ws(payload)
            except Exception:
                logger.exception("Notification consumer error")

    # ── Connection parameter tuning (Linux/BlueZ only) ────────────────────
    async def _tune_connection_params(self) -> None:
        if sys.platform != "linux":
            return
        # Give the link a moment to stabilize before renegotiating parameters.
        # Aggressive intervals (7.5 ms) have been observed to crash/hang Pokit
        # firmware after ~15 s of streaming; use conservative intervals instead.
        await asyncio.sleep(1.0)
        try:
            backend = self.client._backend
            # bleak 0.22+ exposes manager via _backend._client (bluezdbus client)
            client = getattr(backend, "_client", None)
            if client and hasattr(client, "set_connection_parameters"):
                await client.set_connection_parameters(
                    min_interval=24,     # 30 ms
                    max_interval=40,     # 50 ms
                    latency=0,
                    timeout=2000,        # 20 s supervision timeout
                )
                logger.info("BlueZ connection parameters set (30-50 ms intervals, 20 s timeout)")
                return

            # Fallback: use dbus-send to tune via BlueZ Device1 directly
            addr = self.client.address.replace(":", "_")
            subprocess.run(
                [
                    "dbus-send", "--system", "--print-reply",
                    "--dest=org.bluez", f"/org/bluez/hci0/dev_{addr}",
                    "org.freedesktop.DBus.Properties.Set",
                "string:org.bluez.Device1", "string:ConnectionParameters",
                    f"variant:dict:string:uint16:{{'MinInterval':uint16 24,'MaxInterval':uint16 40,'Latency':uint16 0,'Timeout':uint16 2000}}",
                ],
                capture_output=True, text=True, timeout=5,
            )
            logger.info("BlueZ connection parameters tuned via DBus fallback (30-50 ms intervals)")
        except Exception as e:
            logger.warning(f"Could not set BlueZ connection parameters: {e}")

    # ── Connect ─────────────────────────────────────────────────────────────
    async def ble_connect(self, address: Optional[str] = None, skip_disconnect: bool = False) -> bool:
        # Serialize all connect attempts to prevent BlueZ InProgress races
        async with self._connect_lock:
            if self.client and self.client.is_connected:
                logger.info("Already connected")
                return True

            self.state = ConnectionState.CONNECTING
            await self._broadcast_state()

            # If no address given, try config
            if not address:
                cfg = self._load_config()
                if cfg:
                    address = cfg.get("address")
                    logger.info(f"Using cached device: {address}")

            if not address:
                logger.error("No device address provided and no cached config")
                self.state = ConnectionState.DISCONNECTED
                await self._broadcast_state()
                return False

            # Pre-emptively disconnect stale connections so device can advertise.
            # Always force-disconnect the target device, even if it was recently
            # scanned, because it may still be held by the browser's Web BT stack.
            if not skip_disconnect:
                await self._force_disconnect_existing(address)

            # After reboot BlueZ may have dropped the cached device. If we don't
            # already have a fresh BLEDevice from a recent scan, scan first so we
            # can connect directly via the discovered device instead of timing out
            # on a stale MAC address lookup.
            scan_fresh = (asyncio.get_event_loop().time() - self._last_scan_time) < 15.0
            ble_device = self._last_scan_ble_devices.get(address)
            if not (ble_device and scan_fresh):
                logger.info("No fresh BLEDevice cache — scanning before connect")
                await self.ble_scan()
                ble_device = self._last_scan_ble_devices.get(address)
                if ble_device:
                    logger.info(f"Using scanned BLEDevice for {address}")

            for attempt in range(1, 4):
                client_target: BLEDevice | str = address
                # After reboot BlueZ may drop the cached device; use the BLEDevice
                # discovered by our last scan if it is fresh and matches the address.
                scan_fresh = (asyncio.get_event_loop().time() - self._last_scan_time) < 15.0
                ble_device = self._last_scan_ble_devices.get(address)
                if attempt > 1 and ble_device and scan_fresh:
                    client_target = ble_device
                    logger.info(f"Retry attempt {attempt} using scanned BLEDevice for {address}")

                try:
                    self.client = BleakClient(client_target, disconnected_callback=self._on_disconnected)
                    await self.client.connect(timeout=10.0)
                    if not self.client.is_connected:
                        raise RuntimeError("Connection failed")

                    # Identify device
                    name = self.client._backend._device_info.get("Name", "Pokit Pro")
                    self.device_info = {"name": name, "address": address}
                    self._save_config(address, name)

                    # Auto-reconnect by default once user has connected a device
                    self.auto_reconnect = True
                    cfg = self._load_config() or {}
                    cfg["auto_reconnect"] = True
                    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                    CONFIG_FILE.write_text(json.dumps(cfg))

                    # Fresh connection — previous subscriptions are no longer active on device
                    self._active_subscriptions.clear()

                    self.state = ConnectionState.CONNECTED
                    self.retry_count = 0
                    await self._broadcast_state()

                    # Tune connection params for lower latency + longer supervision timeout
                    await self._tune_connection_params()

                    # Start notification consumer if not running
                    if not self._consumer_task or self._consumer_task.done():
                        self._consumer_task = asyncio.create_task(self._consume_notifications())

                    # Start keepalive to prevent BlueZ supervision timeout
                    self._start_keepalive()

                    logger.info(f"Connected to {name} ({address})")
                    return True

                except BleakError as e:
                    err_msg = str(e)
                    if "InProgress" in err_msg and attempt < 3:
                        logger.warning(f"BLE adapter busy (attempt {attempt}/3), retrying in 3s...")
                        await asyncio.sleep(3.0)
                        continue
                    logger.error(f"Connection failed (attempt {attempt}/3): {e}")
                    # If the device disappeared from BlueZ cache, scan before the next attempt
                    if "not found" in err_msg.lower() and attempt < 3:
                        logger.info("BlueZ cache miss — scanning before next connect attempt")
                        await self.ble_scan()
                        await asyncio.sleep(1.0)
                        continue
                    break
                except Exception as e:
                    logger.error(f"Connection failed (attempt {attempt}/3): {e}")
                    break

            self.state = ConnectionState.DISCONNECTED
            await self._broadcast_state()
            # Keep cached config so we can disconnect stale connections on retry
            if self.auto_reconnect:
                self._start_reconnect(address)
            return False

    # ── Disconnect ────────────────────────────────────────────────────────
    async def ble_disconnect(self) -> None:
        self.auto_reconnect = False
        self._stop_reconnect()
        self._stop_keepalive()

        if self._consumer_task:
            self._consumer_task.cancel()
            self._consumer_task = None

        # Unsubscribe all active notifications
        for char_uuid in list(self._active_subscriptions):
            try:
                await self.client.stop_notify(char_uuid)
            except Exception:
                pass
        self._active_subscriptions.clear()

        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            self.client = None

        self.state = ConnectionState.DISCONNECTED
        self.device_info = None
        await self._broadcast_state()
        logger.info("Disconnected")

    # ── Force disconnect any existing BlueZ connections ─────────────────────
    async def _force_disconnect_existing(self, address: Optional[str] = None) -> None:
        """Disconnect stale BlueZ connections so device can advertise again.
        Only disconnects the target Pokit device, never headphones etc."""
        try:
            # If no address given, try cached config
            if not address:
                cfg = self._load_config()
                if cfg:
                    address = cfg.get("address")

            if not address:
                return

            # Always disconnect the target device from BlueZ so it resumes
            # advertising and our bridge (not the OS widget) can claim it.
            # We never "remove" the device — that would destroy pairing keys.
            subprocess.run(
                ["bluetoothctl", "disconnect", address],
                capture_output=True, text=True, timeout=5
            )
            logger.info(f"Disconnected existing BlueZ connection to {address}")
            await asyncio.sleep(1.0)  # Brief wait for advertising to resume
        except Exception as e:
            logger.debug(f"Could not disconnect existing: {e}")

    # ── Scan ────────────────────────────────────────────────────────────────
    async def ble_scan(self) -> list[dict]:
        self.state = ConnectionState.SCANNING
        await self._broadcast_state()

        # Disconnect any existing connections so Pokit can advertise
        await self._force_disconnect_existing()

        # Use callback-based scanning for better real-time detection
        pokit_devices = []
        seen = set()
        cached_cfg = self._load_config()
        cached_addr = (cached_cfg.get("address") if cached_cfg else None)

        def on_detect(device: BLEDevice, advertisement_data):
            # Match by name (case-insensitive), known service UUIDs, or cached address
            name = (device.name or advertisement_data.local_name or "").lower()
            uuids = advertisement_data.service_uuids or []
            is_pokit = (
                "pokit" in name
                or any(u.upper() in [s.upper() for s in ALL_SERVICES] for u in uuids)
                or (cached_addr and device.address.upper() == cached_addr.upper())
            )
            logger.debug(
                f"Scan saw {device.address}: name='{device.name or advertisement_data.local_name}' "
                f"rssi={advertisement_data.rssi} uuids={uuids} is_pokit={is_pokit}"
            )
            if is_pokit and device.address not in seen:
                seen.add(device.address)
                display_name = device.name or advertisement_data.local_name or "Pokit Device"
                pokit_devices.append({"name": display_name, "address": device.address})
                self._last_scan_ble_devices[device.address] = device
                logger.info(f"Found Pokit: {display_name} ({device.address})")

        logger.info(f"Starting BLE scan (4s), cached address={cached_addr}")
        for attempt in range(1, 4):
            try:
                async with BleakScanner(on_detect) as scanner:
                    await asyncio.sleep(4.0)
                    # Log all discovered devices for debugging
                    all_devs = scanner.discovered_devices if hasattr(scanner, 'discovered_devices') else []
                    logger.info(f"Scan complete. Total devices seen: {len(all_devs)}, Pokit devices: {len(pokit_devices)}")
                    for dev in all_devs:
                        uuids = dev.metadata.get('uuids', []) if hasattr(dev, 'metadata') and dev.metadata else []
                        logger.info(f"  Discovered: {dev.name or 'Unknown'} ({dev.address}) UUIDs={uuids}")
                break  # Success
            except BleakError as e:
                if "InProgress" in str(e) and attempt < 3:
                    logger.warning(f"BLE adapter busy (attempt {attempt}/3), retrying in 2s...")
                    await asyncio.sleep(2.0)
                else:
                    raise

        if not pokit_devices and cached_addr:
            logger.warning(f"Scan found no Pokit devices (cached address was {cached_addr})")

        if not self.client or not self.client.is_connected:
            self.state = ConnectionState.DISCONNECTED
        else:
            self.state = ConnectionState.CONNECTED
        await self._broadcast_state()
        self._last_scan_devices = pokit_devices
        self._last_scan_time = asyncio.get_event_loop().time()
        return pokit_devices

    # ── GATT read ───────────────────────────────────────────────────────────
    async def gatt_read(self, service_uuid: str, char_uuid: str) -> bytes:
        async with self._gatt_lock:
            if not self.client or not self.client.is_connected:
                raise RuntimeError("Not connected")
            char = await self._get_characteristic(service_uuid, char_uuid)
            return await self.client.read_gatt_char(char)

    # ── GATT write ──────────────────────────────────────────────────────────
    async def gatt_write(self, service_uuid: str, char_uuid: str, data: bytes, without_response: bool = False) -> None:
        async with self._gatt_lock:
            if not self.client or not self.client.is_connected:
                raise RuntimeError("Not connected")
            char = await self._get_characteristic(service_uuid, char_uuid)
            if without_response and "write-without-response" in char.properties:
                await self.client.write_gatt_char(char, data, response=False)
            else:
                await self.client.write_gatt_char(char, data, response=True)

    # ── GATT subscribe ──────────────────────────────────────────────────────
    async def gatt_subscribe(self, service_uuid: str, char_uuid: str) -> None:
        async with self._gatt_lock:
            if not self.client or not self.client.is_connected:
                raise RuntimeError("Not connected")
            char = await self._get_characteristic(service_uuid, char_uuid)
            key = str(char.uuid)
            if key in self._active_subscriptions:
                logger.debug(f"Already subscribed to {char.uuid}, skipping")
                return
            await self.client.start_notify(char, self._on_notification)
            self._active_subscriptions[key] = service_uuid
        logger.info(f"Subscribed to {char.uuid}")

    # ── GATT unsubscribe ──────────────────────────────────────────────────
    async def gatt_unsubscribe(self, service_uuid: str, char_uuid: str) -> None:
        async with self._gatt_lock:
            if not self.client or not self.client.is_connected:
                return
            char = await self._get_characteristic(service_uuid, char_uuid)
            key = str(char.uuid)
            if key not in self._active_subscriptions:
                logger.debug(f"Not subscribed to {char.uuid}, skipping")
                return
            await self.client.stop_notify(char)
            self._active_subscriptions.pop(key, None)
        # Release lock before sleeping — lets gatt_subscribe proceed sooner
        # while still giving Pokit firmware time to settle its notification state
        await asyncio.sleep(0.3)
        logger.info(f"Unsubscribed from {char.uuid}")

    # ── Helper: resolve characteristic ──────────────────────────────────────
    async def _get_characteristic(self, service_uuid: str, char_uuid: str):
        # bleak 3.x: services are auto-cached, use client.services
        if self.client.services:
            svc = self.client.services.get_service(service_uuid)
            if svc:
                for char in svc.characteristics:
                    if str(char.uuid).lower() == char_uuid.lower():
                        return char
        # bleak 3.x accepts UUID strings directly for all GATT ops
        return char_uuid

    # ── Auto-reconnect ──────────────────────────────────────────────────────
    def _start_reconnect(self, address: str) -> None:
        if self._reconnect_task and not self._reconnect_task.done():
            return
        if self.state == ConnectionState.RECONNECTING:
            return
        self._reconnect_task = asyncio.create_task(self._reconnect_loop(address))

    def _stop_reconnect(self) -> None:
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
        self._reconnect_task = None
        self.retry_count = 0

    async def _reconnect_loop(self, address: str) -> None:
        for attempt in range(1, MAX_RECONNECT_RETRIES + 1):
            if not self.auto_reconnect:
                break
            if self.client and self.client.is_connected:
                break

            self.state = ConnectionState.RECONNECTING
            self.retry_count = attempt
            await self._broadcast_state()

            delay_ms = RECONNECT_BACKOFF_MS[min(attempt - 1, len(RECONNECT_BACKOFF_MS) - 1)]
            logger.info(f"Reconnect attempt {attempt}/{MAX_RECONNECT_RETRIES} in {delay_ms}ms")
            await asyncio.sleep(delay_ms / 1000.0)

            # Scan first on early attempts so we don't hammer a non-advertising device
            if attempt <= 2:
                recently_scanned = any(d["address"] == address for d in self._last_scan_devices)
                scan_fresh = (asyncio.get_event_loop().time() - self._last_scan_time) < 15.0
                if not (recently_scanned and scan_fresh):
                    logger.info(f"Scanning for {address} before reconnect attempt {attempt}")
                    await self.ble_scan()
                    recently_scanned = any(d["address"] == address for d in self._last_scan_devices)
                    if not recently_scanned:
                        logger.warning(f"Device {address} not found in scan, backing off")
                        continue

            # Snapshot before ble_connect — it clears _active_subscriptions internally
            subs_to_restore = list(self._active_subscriptions.items())
            if await self.ble_connect(address, skip_disconnect=True):
                # Re-subscribe all characteristics that were active before the drop
                for char_uuid, service_uuid in subs_to_restore:
                    try:
                        await self.gatt_subscribe(service_uuid, char_uuid)
                        logger.info(f"Re-subscribed to {char_uuid}")
                    except Exception as e:
                        logger.warning(f"Failed to re-subscribe {char_uuid}: {e}")
                return

        # Failed after max retries — clear stale subscriptions so manual reconnect works
        self._active_subscriptions.clear()
        self.state = ConnectionState.DISCONNECTED
        self.retry_count = 0
        await self._broadcast_state()
        await self._broadcast_ws({
            "type": "ble_error",
            "error": "Could not reconnect after maximum retries",
            "recoverable": False,
        })

    # ── WebSocket message handlers ────────────────────────────────────────
    async def handle_ws_message(self, ws: websockets.WebSocketServerProtocol, msg: dict) -> None:
        msg_type = msg.get("type")
        req_id = msg.get("req_id")

        try:
            if msg_type == "ble_scan":
                devices = await self.ble_scan()
                await self._safe_send(ws, {"type": "ble_scan_result", "devices": devices, "req_id": req_id})

            elif msg_type == "ble_connect":
                address = msg.get("address")
                skip_disconnect = msg.get("skip_disconnect", False)
                ok = await self.ble_connect(address, skip_disconnect)
                await self._safe_send(ws, {"type": "ble_connected" if ok else "ble_error", "req_id": req_id, "error": None if ok else "Connection failed"})

            elif msg_type == "ble_connect_last":
                ok = await self.ble_connect()
                await self._safe_send(ws, {"type": "ble_connected" if ok else "ble_error", "req_id": req_id, "error": None if ok else "Connection failed"})

            elif msg_type == "ble_disconnect":
                await self.ble_disconnect()
                try:
                    await self._safe_send(ws, {"type": "ble_disconnected", "req_id": req_id})
                except Exception:
                    pass

            elif msg_type == "set_auto_reconnect":
                self.auto_reconnect = msg.get("enabled", False)
                # Update config
                cfg = self._load_config() or {}
                cfg["auto_reconnect"] = self.auto_reconnect
                CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                CONFIG_FILE.write_text(json.dumps(cfg))
                await self._safe_send(ws, {"type": "auto_reconnect_set", "enabled": self.auto_reconnect, "req_id": req_id})

            elif msg_type == "gatt_read":
                data = await self.gatt_read(msg["service"], msg["characteristic"])
                await self._safe_send(ws, {
                    "type": "gatt_read_response",
                    "req_id": req_id,
                    "characteristic": msg["characteristic"],
                    "data": base64.b64encode(data).decode("ascii"),
                })

            elif msg_type == "gatt_write":
                raw = base64.b64decode(msg["data"])
                await self.gatt_write(msg["service"], msg["characteristic"], raw, msg.get("without_response", False))
                await self._safe_send(ws, {
                    "type": "gatt_write_response",
                    "req_id": req_id,
                    "characteristic": msg["characteristic"],
                    "success": True,
                })

            elif msg_type == "gatt_subscribe":
                await self.gatt_subscribe(msg["service"], msg["characteristic"])
                await self._safe_send(ws, {
                    "type": "gatt_subscribed",
                    "req_id": req_id,
                    "characteristic": msg["characteristic"],
                })

            elif msg_type == "gatt_unsubscribe":
                await self.gatt_unsubscribe(msg["service"], msg["characteristic"])
                await self._safe_send(ws, {
                    "type": "gatt_unsubscribed",
                    "req_id": req_id,
                    "characteristic": msg["characteristic"],
                })

            elif msg_type == "settings_get":
                """Return current settings from file."""
                logger.info(f"[WS] settings_get from client, req_id={req_id}")
                settings = self.settings_manager.get()
                await self._safe_send(ws, {
                    "type": "settings",
                    "req_id": req_id,
                    "data": settings
                })
                logger.info(f"[WS] Sent settings response, req_id={req_id}")

            elif msg_type == "settings_set":
                """Apply settings patch and save to file."""
                patch = msg.get("patch", {})
                try:
                    new_settings = self.settings_manager.patch(patch)
                    await self._safe_send(ws, {
                        "type": "settings_ok",
                        "req_id": req_id
                    })
                    logger.info(f"[Settings] Updated via WebSocket")
                except Exception as e:
                    logger.error(f"[Settings] Failed to save: {e}")
                    await self._safe_send(ws, {
                        "type": "settings_error",
                        "req_id": req_id,
                        "message": str(e)
                    })

            else:
                logger.warning(f"Unknown message type: {msg_type}")
                await self._safe_send(ws, {"type": "error", "req_id": req_id, "error": f"Unknown type: {msg_type}"})

        except BleakGATTProtocolError as e:
            logger.warning(f"GATT protocol error handling {msg_type}: {e.args}")
            error_msg = f"GATT Protocol Error: {e.args[1] if len(e.args) > 1 else str(e)}"
            await self._safe_send(ws, {"type": "error", "req_id": req_id, "error": error_msg})

        except websockets.ConnectionClosed:
            pass

        except RuntimeError as e:
            if str(e) == "Not connected":
                # Transient — happens during reconnect; log once at debug
                logger.debug(f"gatt_{msg_type} while not connected")
                await self._safe_send(ws, {"type": "error", "req_id": req_id, "error": str(e)})
            else:
                raise

        except Exception as e:
            logger.exception(f"Error handling {msg_type}")
            await self._safe_send(ws, {"type": "error", "req_id": req_id, "error": str(e)})

    # ── WebSocket connection handler ────────────────────────────────────────
    async def handle_websocket(self, ws: websockets.WebSocketServerProtocol) -> None:
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        self._ws_clients.add(ws)
        logger.info(f"WebSocket client connected from {ws.remote_address}")

        # Send current state immediately
        try:
            await self._safe_send(ws, {
                "type": "ble_state",
                "state": self.state,
                "address": self.device_info.get("address") if self.device_info else None,
                "name": self.device_info.get("name") if self.device_info else None,
                "retry_count": self.retry_count,
            })
        except Exception:
            pass

        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    await self.handle_ws_message(ws, msg)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON from client")
        except websockets.ConnectionClosed:
            pass
        finally:
            self._ws_clients.discard(ws)
            logger.info(f"WebSocket client disconnected")

    def health_check(self, _connection: Any, request: Any) -> Optional[Any]:
        from websockets.datastructures import Headers
        from websockets.http11 import Response

        if request.path == "/health":
            body = b"{\"status\":\"ok\"}"
            return Response(
                200,
                "OK",
                Headers([
                    ("Content-Type", "application/json"),
                    ("Content-Length", str(len(body))),
                    ("Access-Control-Allow-Origin", "*"),
                    ("Access-Control-Allow-Methods", "GET, OPTIONS"),
                ]),
                body,
            )
        return None


# ── Main ────────────────────────────────────────────────────────────────────
async def main() -> None:
    server = PokitBridgeServer()

    ping_interval = 60   # Ping only once per minute to reduce load
    ping_timeout = None  # Don't kill the socket if the browser misses a pong

    ws_server = await websockets.serve(
        server.handle_websocket,
        WS_HOST,
        WS_PORT,
        ping_interval=ping_interval,
        ping_timeout=ping_timeout,
        process_request=server.health_check,
    )

    logger.info(f"Pokit Bridge Server started on ws://{WS_HOST}:{WS_PORT}")
    logger.info(f"WebSocket keepalive: ping_interval={ping_interval}s, ping_timeout=disabled")
    logger.info(f"Config directory: {CONFIG_DIR}")
    logger.info("Connect frontend WebSocket to this address instead of Web Bluetooth")

    await ws_server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
