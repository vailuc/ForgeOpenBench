"""
WaveForge USB Bridge Server
Mirrors pokit_server.py architecture: asyncio + websockets + JSON RPC.

Supports:
  - Hantek 6022BL / Saleae Logic (LA mode, 16ch digital)
  - Hantek 6022BE (DSO mode, 2ch analog)
  - Generic Cypress FX2 clones (firmware upload via fx2lafw)
  - Any sigrok-supported device (sigrok-cli subprocess mode)

WebSocket: ws://localhost:8766
"""

import asyncio
import base64
import collections
import json
import logging
import os
import re
import select
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from concurrent.futures import Future as CFuture

import usb.core
import usb.util
import websockets
from websockets.server import WebSocketServerProtocol

# ---------------------------------------------------------------------------
# Logging setup (mirrors pokit_server.py)
# ---------------------------------------------------------------------------

LOG_DIR = Path(__file__).parent.parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
_log_file = LOG_DIR / f"usb-bridge_{_ts}.log"
_log_link = LOG_DIR / "usb-bridge.log"
try:
    _log_link.unlink(missing_ok=True)
    _log_link.symlink_to(_log_file.name)
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_log_file),
    ],
)
log = logging.getLogger("usb_server")

# ---------------------------------------------------------------------------
# USB device table
# ---------------------------------------------------------------------------

FIRMWARE_DIR = Path(__file__).parent / "firmware"

DEVICES = [
    # 6022BL after 16ch firmware swap: enumerates as sigrok FX2 16ch
    {"vid": 0x1D50, "pid": 0x608D, "name": "Hantek 6022BL (16ch)",   "mode": "la",  "needs_fw": False, "fw": None,                     "sigrok": True,  "sigrok_driver": "fx2lafw"},
    # 6022BL H/P NOT pressed: sigrok fx2lafw — 8-ch logic analyzer (original firmware)
    {"vid": 0x0925, "pid": 0x3881, "name": "Hantek 6022BL",          "mode": "la",  "needs_fw": False, "fw": None,                     "sigrok": True,  "sigrok_driver": "fx2lafw"},
    # 6022BL H/P PRESSED: bare Cypress — upload Ho-Ro firmware, renumerates to 04b5:602a
    {"vid": 0x04B4, "pid": 0x602A, "name": "Hantek 6022BL (Scope)",  "mode": "dso", "needs_fw": True,  "fw": "hantek-6022bl-scope.fw", "sigrok": False, "sigrok_driver": "", "renumerate_vid": 0x04B5, "renumerate_pid": 0x602A},
    # 6022BL after Ho-Ro firmware loaded (04b5:602a) — direct DSO capture
    {"vid": 0x04B5, "pid": 0x602A, "name": "Hantek 6022BL (Scope)",  "mode": "dso", "needs_fw": False, "fw": None,                     "sigrok": False, "sigrok_driver": ""},
    # 6022BE: upload scope firmware for direct USB (test signal, full control)
    {"vid": 0x0925, "pid": 0x3002, "name": "Hantek 6022BE",          "mode": "dso", "needs_fw": True,  "fw": "hantek-6022bl-scope.fw", "sigrok": False, "sigrok_driver": "", "renumerate_vid": 0x04B5, "renumerate_pid": 0x602A},
    # Bare Cypress FX2 (non-Hantek)
    {"vid": 0x04B4, "pid": 0x8613, "name": "Cypress FX2 clone (bare)", "mode": "la", "needs_fw": True, "fw": "fx2lafw-saleae-logic.fw", "sigrok": False, "sigrok_driver": ""},
]

# fx2lafw protocol constants (from sigrok libsigrok)
CMD_START              = 0xB1
FX2_RAM_UPLOAD_REQUEST = 0xA0
FX2_CPUCS_ADDR         = 0xE600  # CPU control/status register: 0x01=reset, 0x00=run
BULK_IN_EP_LA          = 0x82   # fx2lafw logic analyzer bulk IN
BULK_IN_EP_DSO         = 0x86   # Hantek scope bulk IN (EP6)
BULK_IN_EP             = 0x82   # default (overridden per mode)
USB_TIMEOUT            = 5000

# Hantek 6022BL USB IDs (for Rust native capture module)
VID_BARE               = 0x04B4  # Bare Cypress FX2 (H/P button pressed)
PID_BARE               = 0x602A
VID_SCOPE              = 0x04B5  # After Ho-Ro firmware upload
PID_SCOPE              = 0x602A

# Hantek 6022 scope protocol constants (Ho-Ro / rpcope1 reverse engineering)
HANTEK_SET_CH0_RANGE   = 0xE0   # value: 1=5V, 2=2.5V, 5=1V, 10=500mV
HANTEK_SET_CH1_RANGE   = 0xE1
HANTEK_SET_SAMPLERATE  = 0xE2   # value: 48,30,24,16,8,4,1 (MHz); 50,20,10 (*10kHz)
HANTEK_START           = 0xE3   # value: 1=start, 0=stop
HANTEK_SET_TEST_SIG    = 0xE6   # Calibration pulse frequency (NOT 0xE4!)
# Ho-Ro firmware frequency byte encoding (LibUsbScope.py):
#   0       -> 100 Hz (sigrok FW compat)
#   1..100  -> 1..100 kHz (byte = kHz)
#   103     -> 32 Hz (lowest possible)
#   104..200-> 40..1000 Hz, step 10 Hz  (freq = 10*(byte-100))
#   201..255-> 100..5500 Hz, step 100 Hz (freq = 100*(byte-200))
# Encoding: if freq < 1000: byte = (freq+5)//10 + 100
#           elif freq < 5600: byte = (freq+50)//100 + 200
#           else: byte = (freq+500)//1000
HANTEK_VOLT_RANGE = {10.0: 1, 5.0: 2, 2.0: 5, 1.0: 10}
HANTEK_SAMPLERATE_MAP = {  # hz -> device code (matches Ho-Ro LibUsbScope.py)
    48_000_000: 48, 30_000_000: 30, 24_000_000: 24, 16_000_000: 16,
    15_000_000: 15, 12_000_000: 12, 10_000_000: 10,  8_000_000:  8,
     6_000_000:  6,  5_000_000:  5,  4_000_000:  4,  3_000_000:  3,
     2_000_000:  2,  1_000_000:  1,
       500_000: 50,   400_000: 40,   200_000: 20,   128_000: 113,
       100_000: 10,    64_000: 106,   50_000: 105,    40_000: 104,
        32_000: 103,   20_000: 102,
}

CMD_START_FLAGS_SAMPLE_8BIT  = 0 << 5
CMD_START_FLAGS_SAMPLE_16BIT = 1 << 5
CMD_START_FLAGS_CLK_30MHZ    = 0 << 6
CMD_START_FLAGS_CLK_48MHZ    = 1 << 6

MAX_8BIT_SAMPLE_RATE  = 24_000_000
MAX_16BIT_SAMPLE_RATE = 12_000_000

# ---------------------------------------------------------------------------
# USB helpers
# ---------------------------------------------------------------------------

def _usb_device_present(vid: int, pid: int) -> tuple[bool, int, int]:
    """Check USB device presence via sysfs — no libusb handle opened.
    Returns (found, bus, address)."""
    target = f"{vid:04x}:{pid:04x}"
    try:
        for bus_dir in Path("/sys/bus/usb/devices").iterdir():
            id_file = bus_dir / "idVendor"
            if not id_file.exists():
                continue
            v = (bus_dir / "idVendor").read_text().strip()
            p = (bus_dir / "idProduct").read_text().strip()
            if f"{v}:{p}" == target:
                try:
                    bus = int((bus_dir / "busnum").read_text().strip())
                    addr = int((bus_dir / "devnum").read_text().strip())
                except Exception:
                    bus, addr = 0, 0
                return True, bus, addr
    except Exception:
        pass
    return False, 0, 0


def _scan_devices() -> list[dict]:
    found = []
    for d in DEVICES:
        if d.get("sigrok", False):
            # sigrok devices: detect via sysfs — never open a libusb handle
            present, bus, addr = _usb_device_present(d["vid"], d["pid"])
            if present:
                found.append({**d, "address": addr, "bus": bus})
        else:
            dev = usb.core.find(idVendor=d["vid"], idProduct=d["pid"])
            if dev is not None:
                found.append({**d, "address": dev.address, "bus": dev.bus})
                try:
                    usb.util.dispose_resources(dev)
                except Exception:
                    pass
                del dev  # force GC — ensures libusb handle is released before caller returns
    return found


def _build_start_command(sample_rate_hz: int, sample_16bit: bool = True) -> bytes:
    flags = CMD_START_FLAGS_SAMPLE_16BIT if sample_16bit else CMD_START_FLAGS_SAMPLE_8BIT
    delay = (48_000_000 // sample_rate_hz) - 1
    max_delay = 6 * 256
    if delay > max_delay:
        flags |= CMD_START_FLAGS_CLK_30MHZ
        delay = (30_000_000 // sample_rate_hz) - 1
    else:
        flags |= CMD_START_FLAGS_CLK_48MHZ
    delay = max(0, min(delay, max_delay))
    return bytes([flags, (delay >> 8) & 0xFF, delay & 0xFF])


def _upload_firmware(dev: usb.core.Device, fw_path: Path) -> None:
    """Upload firmware to FX2. Supports Intel HEX (.hex) and raw flat binary."""
    log.info(f"Uploading firmware: {fw_path.name}")

    # Assert CPU reset
    dev.ctrl_transfer(0x40, FX2_RAM_UPLOAD_REQUEST, FX2_CPUCS_ADDR, 0, b"\x01", USB_TIMEOUT)

    raw = fw_path.read_bytes()
    is_ihex = raw[:1] == b":"  # Intel HEX starts with ':' regardless of extension
    if is_ihex:
        # Parse Intel HEX — upload each record to its specified address
        for line in fw_path.read_text().splitlines():
            line = line.strip()
            if not line.startswith(":"):
                continue
            rec = bytes.fromhex(line[1:])
            byte_count = rec[0]
            address    = (rec[1] << 8) | rec[2]
            rec_type   = rec[3]
            if rec_type == 0x01:  # EOF
                break
            if rec_type != 0x00:  # skip non-data records
                continue
            data = rec[4:4 + byte_count]
            dev.ctrl_transfer(0x40, FX2_RAM_UPLOAD_REQUEST, address, 0, data, USB_TIMEOUT)
    else:
        # Raw flat binary — write sequentially from address 0
        data = raw
        chunk_size = 256
        addr = 0x0000
        for i in range(0, len(data), chunk_size):
            chunk = data[i:i + chunk_size]
            dev.ctrl_transfer(0x40, FX2_RAM_UPLOAD_REQUEST, addr, 0, chunk, USB_TIMEOUT)
            addr += len(chunk)

    # Release CPU reset — FX2 executes new firmware and renumerates
    dev.ctrl_transfer(0x40, FX2_RAM_UPLOAD_REQUEST, FX2_CPUCS_ADDR, 0, b"\x00", USB_TIMEOUT)
    log.info("Firmware uploaded, CPU released, waiting for renumeration...")


def _wait_renumeration(vid: int, pid: int, timeout: float = 15.0) -> Optional[usb.core.Device]:
    """Wait for device to reappear after firmware upload.
    Checks for fx2lafw (1d50:608d), original VID:PID, and logs all USB devices seen."""
    deadline = time.monotonic() + timeout
    logged_pids: set = set()
    time.sleep(1.5)
    while time.monotonic() < deadline:
        # Log all currently visible devices (helps identify unknown renumeration PID)
        all_devs = list(usb.core.find(find_all=True))
        for d in all_devs:
            key = (d.idVendor, d.idProduct)
            if key not in logged_pids:
                logged_pids.add(key)
                log.info(f"  USB device seen: {d.idVendor:04x}:{d.idProduct:04x}")

        # Preferred: renumerated to sigrok fx2lafw VID:PID
        dev = usb.core.find(idVendor=0x1D50, idProduct=0x608D)
        if dev is not None:
            log.info("Device renumerated: 1d50:608d (fx2lafw)")
            return dev
        # Fallback: came back with original VID:PID
        dev = usb.core.find(idVendor=vid, idProduct=pid)
        if dev is not None:
            log.info(f"Device renumerated: {vid:04x}:{pid:04x} (original PID)")
            return dev
        time.sleep(0.5)
    log.warning(f"Renumeration timeout — device did not reappear as {vid:04x}:{pid:04x} or 1d50:608d")
    return None

# ---------------------------------------------------------------------------
# Capture state
# ---------------------------------------------------------------------------

@dataclass
class CaptureConfig:
    mode: str = "la"          # "la" or "dso"
    sample_rate_hz: int = 12_000_000
    sample_width: int = 16    # 8 or 16
    voltage_range: float = 1.0  # Vpp for DSO
    test_signal: str = "off"   # "off", "32 Hz".."100 kHz"
    sigrok: bool = False
    sigrok_driver: str = ""

@dataclass
class ServerState:
    device: Optional[usb.core.Device] = None
    device_info: Optional[dict] = None
    config: CaptureConfig = field(default_factory=CaptureConfig)
    capturing: bool = False
    stop_event: threading.Event = field(default_factory=threading.Event)
    capture_thread: Optional[threading.Thread] = None
    clients: set = field(default_factory=set)
    sigrok_proc: Optional[subprocess.Popen] = None
    rust_proc: Optional[subprocess.Popen] = None

state = ServerState()
_state_lock = asyncio.Lock()
_loop: Optional[asyncio.AbstractEventLoop] = None

# ---------------------------------------------------------------------------
# Broadcast to all WS clients
# ---------------------------------------------------------------------------
# The capture threads produce frames much faster than the browser can paint or
# the TCP socket can drain. For text (control) messages we keep only one in-flight
# broadcast and drop new usb_data frames when back-pressured. For binary DSO frames
# we now queue them all; dropping binary frames makes the waveform age creep behind
# wall time.
_pending_text: Optional[CFuture[None]] = None


def _is_pending(fut: Optional[CFuture[None]]) -> bool:
    return fut is not None and not fut.done()


def broadcast_sync(msg: dict) -> None:
    global _pending_text
    if _loop is None or not state.clients:
        return
    data = json.dumps(msg)
    # Data frames can be dropped when the browser is behind; control messages
    # (errors, stopped/connected events) must always be delivered.
    if msg.get("type") == "usb_data" and _is_pending(_pending_text):
        return
    _pending_text = asyncio.run_coroutine_threadsafe(_broadcast(data), _loop)


async def _broadcast(data: str) -> None:
    dead = set()
    for ws in list(state.clients):
        try:
            await ws.send(data)
        except Exception:
            dead.add(ws)
    state.clients -= dead


def broadcast_binary_sync(data: bytes) -> None:
    """Broadcast raw binary frame to all websocket clients.
    Do not drop frames here; let the asyncio queue absorb any backpressure.
    Dropping frames makes the waveform age creep behind wall time."""
    if _loop is None or not state.clients:
        return
    asyncio.run_coroutine_threadsafe(_broadcast_binary(data), _loop)


async def _broadcast_binary(data: bytes) -> None:
    dead = set()
    for ws in list(state.clients):
        try:
            await ws.send(data)
        except Exception:
            dead.add(ws)
    state.clients -= dead

# ---------------------------------------------------------------------------
# Direct capture (pyusb bulk IN)
# ---------------------------------------------------------------------------

def _encode_cal_freq(freq_hz: int) -> int:
    """Encode calibration frequency in Hz to firmware byte value.
    Matches Ho-Ro LibUsbScope.py encoding:
      0       -> 100 Hz (sigrok FW compat)
      1..100  -> 1..100 kHz
      103     -> 32 Hz (lowest possible)
      104..200-> 40..1000 Hz, step 10 Hz
      201..255-> 100..5500 Hz, step 100 Hz
    """
    if freq_hz < 1000:
        return int((freq_hz + 5) // 10) + 100   # 103...199 -> 32...990 Hz
    elif freq_hz < 5600:
        return int((freq_hz + 50) // 100) + 200   # 201...255 -> 100...5500 Hz
    else:
        return int((freq_hz + 500) // 1000)       # 1...100 -> 1...100 kHz


def _hantek_set_test_signal(dev: usb.core.Device, freq_hz: int) -> bool:
    """Set Hantek calibration pulse frequency using command 0xE6.
    freq_hz: 32..100000 Hz (0 = off, don't send command)
    """
    if freq_hz == 0:
        log.info("Calibration pulse: off (no command sent)")
        return True
    
    if freq_hz < 32 or freq_hz > 100000:
        log.warning(f"Calibration frequency {freq_hz} Hz out of range (32..100k)")
        return False
    
    frequency_byte = _encode_cal_freq(freq_hz)
    try:
        dev.ctrl_transfer(0x40, HANTEK_SET_TEST_SIG, 0, 0, bytes([frequency_byte]), USB_TIMEOUT)
        log.info(f"Hantek calibration pulse: {freq_hz} Hz (byte=0x{frequency_byte:02x})")
        return True
    except Exception as e:
        log.error(f"Hantek calibration pulse setup failed: {e}")
        return False

def _hantek_setup(dev: usb.core.Device, cfg) -> bool:
    """Send Hantek scope vendor commands before capture: voltage range, samplerate, start.
    Protocol: wValue=0, wIndex=0, data=bytes([param]) — firmware reads EP0BUF[0].
    Matches Ho-Ro/LibUsbScope.py controlWrite(0x40, request, 0, 0, bytes([param])).
    """
    best_hz = min(HANTEK_SAMPLERATE_MAP.keys(), key=lambda k: abs(k - cfg.sample_rate_hz))
    rate_code = HANTEK_SAMPLERATE_MAP[best_hz]

    # Map frontend vpp to Hantek code: code 1=±5V(10Vpp), 2=±2.5V(5Vpp), 5=±1V(2Vpp), 10=±500mV(1Vpp)
    voltage_range = getattr(cfg, 'voltage_range', 2.0)
    if voltage_range == 10.0:
        volt_code = 1
    elif voltage_range == 5.0:
        volt_code = 2
    elif voltage_range == 2.0:
        volt_code = 5
    elif voltage_range == 1.0:
        volt_code = 10
    else:
        volt_code = 5

    # Ensure interface is claimed (idempotent if already claimed by handle_usb_connect)
    try:
        if dev.is_kernel_driver_active(0):
            dev.detach_kernel_driver(0)
    except Exception:
        pass
    try:
        usb.util.claim_interface(dev, 0)
    except Exception:
        pass

    def _cmd(name: str, req: int, data: bytes) -> bool:
        try:
            dev.ctrl_transfer(0x40, req, 0, 0, data, USB_TIMEOUT)
            return True
        except Exception as e:
            log.error(f"Hantek cmd {name} failed: {e}")
            return False

    # Stop sampling first
    if not _cmd("STOP", HANTEK_START, b"\x00"):
        return False
    time.sleep(0.05)

    # clear_halt is best-effort — don't fail setup if it errors
    try:
        dev.clear_halt(BULK_IN_EP_DSO)
    except Exception as e:
        log.warning(f"clear_halt best-effort failed: {e}")
    time.sleep(0.05)

    # Configure channels and rate
    if not _cmd("CH0_RANGE", HANTEK_SET_CH0_RANGE, bytes([volt_code])):
        return False
    time.sleep(0.01)
    if not _cmd("CH1_RANGE", HANTEK_SET_CH1_RANGE, bytes([volt_code])):
        return False
    time.sleep(0.01)
    if not _cmd("SAMPLERATE", HANTEK_SET_SAMPLERATE, bytes([rate_code])):
        return False
    time.sleep(0.01)

    # Apply test signal if requested
    test_freq_name = getattr(cfg, 'test_signal', 'off')
    name_to_hz = {
        "off": 0, "32 Hz": 32, "50 Hz": 50, "100 Hz": 100,
        "200 Hz": 200, "500 Hz": 500, "1 kHz": 1000, "2 kHz": 2000,
        "5 kHz": 5000, "10 kHz": 10000, "50 kHz": 50000, "100 kHz": 100000,
    }
    freq_hz = name_to_hz.get(test_freq_name, 0)
    if freq_hz > 0:
        if not _hantek_set_test_signal(dev, freq_hz):
            return False
        time.sleep(0.05)

    # Start sampling
    if not _cmd("START", HANTEK_START, b"\x01"):
        return False

    log.info(f"Hantek setup OK: rate_code={rate_code} ({best_hz//1000}kHz) volt_code={volt_code} ({voltage_range}V)")
    return True


def _reacquire_device() -> bool:
    """Try to find and claim the USB device after Rust releases it.
    Returns True if a device was acquired."""
    info = state.device_info or {}
    candidates = [
        (info.get("vid", VID_SCOPE), info.get("pid", PID_SCOPE)),
        (info.get("renumerate_vid", VID_SCOPE), info.get("renumerate_pid", PID_SCOPE)),
    ]
    for vid, pid in candidates:
        try:
            dev = usb.core.find(idVendor=vid, idProduct=pid)
            if dev:
                state.device = dev
                log.info(f"Re-acquired device {vid:04x}:{pid:04x}")
                return True
        except Exception as e:
            log.warning(f"Failed to re-acquire device {vid:04x}:{pid:04x}: {e}")
    return False


def _capture_loop_rust() -> None:
    """Spawn Rust hantek-capture binary for DSO mode.
    Reads binary frames from stdout and forwards as websocket binary messages."""
    cfg = state.config
    info = state.device_info or {}

    # If Python already uploaded firmware during connect, the device has renumerated
    # to 04b5:602a. Tell Rust to find the scope PID, not the bare one.
    # Do NOT pass --firmware — Python already handled it.
    needs_fw = info.get("needs_fw", False)
    vid = VID_SCOPE if needs_fw else info.get("vid", VID_SCOPE)
    pid = PID_SCOPE if needs_fw else info.get("pid", PID_SCOPE)

    # Release pyusb handle so Rust can claim the interface
    if state.device is not None:
        try:
            usb.util.dispose_resources(state.device)
        except Exception:
            pass
        state.device = None

    # Build command line for Rust binary
    rust_bin = Path(__file__).parent / "hantek-capture" / "target" / "release" / "hantek-capture"
    if not rust_bin.exists():
        # Try debug build fallback
        rust_bin = Path(__file__).parent / "hantek-capture" / "target" / "debug" / "hantek-capture"

    # Target ~30fps worth of bytes per frame, capped between 8KB and 512KB.
    # Lower fps prevents the frontend queue from backing up, while still looking smooth.
    target = max(512 * 16, min(512 * 1024, ((cfg.sample_rate_hz // 30 + 511) // 512) * 512))

    cmd = [
        str(rust_bin),
        "--vid", f"0x{vid:04x}",
        "--pid", f"0x{pid:04x}",
        "--rate", str(cfg.sample_rate_hz),
        "--vpp", str(cfg.voltage_range),
        "--read-size", str(target),
    ]

    # Test signal
    test_freq_name = cfg.test_signal
    name_to_hz = {
        "off": 0, "32 Hz": 32, "50 Hz": 50, "100 Hz": 100,
        "200 Hz": 200, "500 Hz": 500, "1 kHz": 1000, "2 kHz": 2000,
        "5 kHz": 5000, "10 kHz": 10000, "50 kHz": 50000, "100 kHz": 100000,
    }
    test_freq = name_to_hz.get(test_freq_name, 0)
    if test_freq > 0:
        cmd.extend(["--test-freq", str(test_freq)])

    log.info(f"Spawning Rust capture: {' '.join(cmd)}")
    spawn_t0 = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:
        log.error(f"Failed to spawn Rust binary: {e}")
        broadcast_sync({"type": "usb_error", "message": f"Rust capture failed: {e}"})
        return

    first_frame_logged = False

    # Drain stderr in background. The Rust binary can emit a tight error loop
    # when the device is unplugged, so suppress duplicates and stop on fatal
    # device errors rather than logging every single line.
    def _drain_stderr():
        import time
        last_text = ""
        last_ts = 0.0
        suppressed = 0
        for line in proc.stderr:
            text = line.decode(errors="replace").rstrip()
            now = time.time()
            # Fatal errors mean the device is gone; signal shutdown.
            if "No such device" in text or "device has been disconnected" in text:
                log.error(f"[hantek-capture] {text}")
                state.stop_event.set()
                break
            # Suppress repeat messages within a 5-second window.
            if text == last_text and now - last_ts < 5.0:
                suppressed += 1
                continue
            if suppressed > 0:
                log.info(f"[hantek-capture] (suppressed {suppressed} identical lines)")
                suppressed = 0
            last_text = text
            last_ts = now
            log.info(f"[hantek-capture] {text}")
    threading.Thread(target=_drain_stderr, daemon=True).start()

    state.rust_proc = proc
    chunks = 0

    # Read length-prefixed binary frames from stdout
    # Frame format: [4:msg_len][4:rate_hz][4:n_bytes][8:timestamp_us][4:reserved][n:raw_data]
    while not state.stop_event.is_set():
        try:
            # Read 4-byte length header
            hdr = proc.stdout.read(4)
            if len(hdr) < 4:
                break
            msg_len = int.from_bytes(hdr, 'little')
            if msg_len < 24 or msg_len > 2_000_000:
                log.warning(f"Invalid frame length: {msg_len}")
                break

            # Read rest of frame
            frame = proc.stdout.read(msg_len - 4)
            if len(frame) < msg_len - 4:
                break

            chunks += 1
            if chunks <= 3:
                log.info(f"Rust frame #{chunks}: {msg_len} bytes")
            if not first_frame_logged:
                first_frame_logged = True
                log.info(f"Rust first frame after {time.monotonic() - spawn_t0:.2f}s")

            # Forward complete frame to frontend (hdr + rest)
            broadcast_binary_sync(hdr + frame)

        except Exception as e:
            if not state.stop_event.is_set():
                log.error(f"Rust stdout read error: {e}")
            break

    # Cleanup
    state.rust_proc = None
    try:
        proc.terminate()
        proc.wait(timeout=2)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    # Mark state clean so backend doesn't think we're still capturing
    # (crucial when device is unplugged and Rust exits on its own)
    was_unexpected = not state.stop_event.is_set()
    state.capturing = False
    state.capture_thread = None

    if was_unexpected:
        # Rust exited on its own (device may have been unplugged) — notify frontend
        broadcast_sync({"type": "usb_stopped"})
        log.warning("Rust capture exited unexpectedly (device may have been unplugged)")

    log.info("Rust capture loop exited")


def _capture_loop_direct() -> None:
    dev = state.device
    if dev is None:
        return

    cfg = state.config
    is_dso = cfg.mode == "dso"

    # DSO mode: use Rust native binary for real-time performance
    if is_dso:
        _capture_loop_rust()
        return

    # LA mode: keep pyusb path for fx2lafw
    ep = BULK_IN_EP_LA
    sample_16bit = cfg.sample_width == 16
    rate = min(cfg.sample_rate_hz,
               MAX_16BIT_SAMPLE_RATE if sample_16bit else MAX_8BIT_SAMPLE_RATE)
    cmd = _build_start_command(rate, sample_16bit)
    try:
        dev.ctrl_transfer(0x40, CMD_START, 0, 0, cmd, USB_TIMEOUT)
        log.info(f"CMD_START sent: rate={rate} width={cfg.sample_width}")
    except Exception as e:
        broadcast_sync({"type": "usb_error", "message": f"CMD_START failed: {e}"})
        return

    read_size = 512 * 16  # 8 KiB LA
    chunks_received = 0
    consecutive_errors = 0
    MAX_CONSECUTIVE_ERRORS = 5
    while not state.stop_event.is_set():
        try:
            data = dev.read(ep, read_size, timeout=500)
            consecutive_errors = 0
            if len(data) > 0:
                chunks_received += 1
                if chunks_received <= 3:
                    log.info(f"Bulk IN EP{ep:#x} chunk #{chunks_received}: {len(data)} bytes")
                broadcast_sync({
                    "type": "usb_data",
                    "mode": cfg.mode,
                    "ts": time.time(),
                    "rate": rate,
                    "width": cfg.sample_width,
                    "samples": len(data) // (2 if sample_16bit else 1),
                    "b64": base64.b64encode(bytes(data)).decode("ascii"),
                })
        except usb.core.USBTimeoutError:
            continue
        except usb.core.USBError as e:
            if state.stop_event.is_set():
                break
            consecutive_errors += 1
            log.warning(f"Bulk read USBError #{consecutive_errors}: {e}")
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                broadcast_sync({"type": "usb_error", "message": f"USB error after {consecutive_errors} retries: {e}"})
                break
            time.sleep(0.05 * consecutive_errors)
            continue
        except Exception as e:
            if not state.stop_event.is_set():
                log.error(f"Bulk read error: {e}")
                broadcast_sync({"type": "usb_error", "message": str(e)})
            break

    try:
        dev.clear_halt(ep)
    except Exception:
        pass

    # Mark state clean if we exited unexpectedly (device unplugged)
    if not state.stop_event.is_set():
        state.capturing = False
        state.capture_thread = None
        broadcast_sync({"type": "usb_stopped"})
        log.warning("Capture loop exited unexpectedly (device may have been unplugged)")
    log.info("Capture loop exited")

# ---------------------------------------------------------------------------
# Sigrok capture (subprocess pipe)
# ---------------------------------------------------------------------------

def _capture_loop_sigrok() -> None:
    cfg = state.config
    driver = cfg.sigrok_driver or "fx2lafw"

    # sigrok-cli manages the device exclusively — state.device is always None here
    # (scan uses sysfs, connect sets state.device=None for sigrok mode)
    state.device = None

    # Single persistent subprocess — device stays open the whole time,
    # no repeated open/close that causes LIBUSB_ERROR_TIMEOUT on fx2lafw.
    PIPE_CHUNK = 8_192  # bytes per read iteration
    bps = 2 if cfg.sample_width == 16 else 1

    # Two-step boot (see sigrok-bugreport-draft.md + sigrok-evidence.txt):
    #
    # When plugged in, FX2 starts as 0925:3881 (raw, no firmware in RAM).
    # First --continuous: sigrok uploads firmware, FX2 re-enumerates to
    #   1d50:608d, libsigrok's re-enum wait fails (searches wrong VID:PID),
    #   process exits — BUT device stays loaded at 1d50:608d.
    # Second --continuous: sigrok sees 1d50:608d, checks manufacturer/product
    #   strings "sigrok"/"fx2lafw" via usb_match_manuf_prod(), skips firmware
    #   upload (fw_updated=0), opens directly → streams indefinitely.
    #
    # So: run a warmup attempt first if device is raw, wait for it to exit,
    # then launch the real --continuous.

    raw_present, _, _ = _usb_device_present(0x0925, 0x3881)
    pf_present, _, _ = _usb_device_present(0x1D50, 0x608D)

    if raw_present and not pf_present:
        log.info("fx2lafw: device raw (0925:3881) — running warmup to load firmware")
        try:
            subprocess.run(
                ["sigrok-cli", "--driver", driver, "--continuous", "--output-format", "binary"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8
            )
        except Exception:
            pass
        log.info("fx2lafw: warmup done, waiting for 1d50:608d to settle")
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            found, _, _ = _usb_device_present(0x1D50, 0x608D)
            if found:
                break
            time.sleep(0.2)
        time.sleep(0.5)

    pf_now, _, _ = _usb_device_present(0x1D50, 0x608D)
    if not pf_now:
        log.warning("fx2lafw: 1d50:608d not present after warmup — aborting")
        broadcast_sync({"type": "usb_error", "message": "Device firmware not loaded. Replug and try again."})
        return

    log.info(f"Starting sigrok --continuous: driver={driver} (1d50:608d ready)")

    cmd = [
        "sigrok-cli",
        "--driver", driver,
        "--continuous",
        "--output-format", "binary",
    ]

    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        broadcast_sync({"type": "usb_error", "message": "sigrok-cli not found"})
        return

    # Check it didn't die immediately
    time.sleep(0.1)
    if proc.poll() is not None:
        err = proc.stderr.read().decode(errors="replace").strip()
        log.error(f"sigrok-cli exited immediately (rc={proc.returncode}): {err!r}")
        state.capturing = False
        broadcast_sync({"type": "usb_stopped"})
        return

    state.sigrok_proc = proc
    buf = bytearray()
    chunks_sent = 0

    def _drain_stderr():
        for line in proc.stderr:
            log.warning(f"sigrok: {line.decode(errors='replace').rstrip()}")

    threading.Thread(target=_drain_stderr, daemon=True).start()

    read_queue: collections.deque[bytes] = collections.deque()
    read_done = threading.Event()

    def _read_stdout():
        try:
            while True:
                raw = proc.stdout.read(PIPE_CHUNK)
                if not raw:
                    break
                read_queue.append(raw)
        except Exception as exc:
            log.warning(f"sigrok stdout reader error: {exc}")
        finally:
            log.info(f"sigrok stdout reader done (rc={proc.poll()})")
            read_done.set()

    threading.Thread(target=_read_stdout, daemon=True).start()

    try:
        while not state.stop_event.is_set():
            if read_queue:
                raw = read_queue.popleft()
                buf.extend(raw)
                aligned = len(buf) - (len(buf) % bps)
                if aligned < bps:
                    continue
                chunk_bytes = bytes(buf[:aligned])
                buf = buf[aligned:]
                chunks_sent += 1
                if chunks_sent <= 3:
                    log.info(f"sigrok stream chunk #{chunks_sent}: {len(chunk_bytes)} bytes")
                broadcast_sync({
                    "type": "usb_data",
                    "mode": cfg.mode,
                    "ts": time.time(),
                    "rate": cfg.sample_rate_hz,
                    "width": cfg.sample_width,
                    "samples": len(chunk_bytes) // bps,
                    "b64": base64.b64encode(chunk_bytes).decode("ascii"),
                })
            elif read_done.is_set():
                break
            else:
                time.sleep(0.005)
    finally:
        # SIGINT was already sent by _stop_capture() before stop_event was set.
        # Just wait for the process to exit cleanly, then escalate if needed.
        try:
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try: proc.kill()
                except Exception: pass
        state.sigrok_proc = None

    state.capturing = False
    log.info("Sigrok capture loop exited")

# ---------------------------------------------------------------------------
# Firmware management
# ---------------------------------------------------------------------------

def get_waveforge_firmware_dir() -> Path:
    """Get the user-local firmware directory for WaveForge."""
    return Path.home() / ".local" / "share" / "sigrok-firmware"


def set_waveforge_firmware_link(mode: str) -> bool:
    """
    Explicitly symlinks the active firmware profile to the 
    default filename sigrok-cli searches for.
    
    Args:
        mode: "8ch" or "16ch"
        
    Returns:
        True if successful, False otherwise
    """
    try:
        fw_dir = get_waveforge_firmware_dir()
        fw_dir.mkdir(parents=True, exist_ok=True)
        
        # Define our source binaries
        source_fw = f"fx2lafw-hantek-{mode}.fw"
        source_path = fw_dir / source_fw
        
        # The default target link sigrok expects for VID:PID 0925:3881
        link_path = fw_dir / "fx2lafw-saleae-logic.fw"
        
        # Ensure source firmware exists
        if not source_path.exists():
            log.error(f"Source firmware not found: {source_path}")
            return False
        
        # Clean up the old symlink safely if it exists
        if link_path.is_symlink() or link_path.exists():
            link_path.unlink()
            
        # Create the new explicit symlink pointing to our selected mode
        os.symlink(source_path, link_path)
        
        log.info(f"[WaveForge] Active firmware linked: {link_path.name} -> {source_fw}")
        return True
        
    except Exception as e:
        log.error(f"Failed to set firmware link to {mode}: {e}")
        return False


def get_waveforge_firmware_status() -> dict:
    """Get current firmware configuration status."""
    try:
        fw_dir = get_waveforge_firmware_dir()
        link_path = fw_dir / "fx2lafw-saleae-logic.fw"
        
        status = {
            "firmware_dir": str(fw_dir),
            "8ch_available": (fw_dir / "fx2lafw-hantek-8ch.fw").exists(),
            "16ch_available": (fw_dir / "fx2lafw-hantek-16ch.fw").exists(),
            "current_link": None,
            "current_mode": None
        }
        
        if link_path.is_symlink():
            target = link_path.resolve()
            status["current_link"] = str(target)
            if "16ch" in target.name:
                status["current_mode"] = "16ch"
            elif "8ch" in target.name:
                status["current_mode"] = "8ch"
        
        return status
        
    except Exception as e:
        log.error(f"Failed to get firmware status: {e}")
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# RPC handlers
# ---------------------------------------------------------------------------

async def handle_usb_scan(ws: WebSocketServerProtocol, _req: dict) -> dict:
    devices = _scan_devices()
    log.info(f"Scan found {len(devices)} device(s)")
    return {"type": "usb_scan_result", "devices": devices}


async def handle_usb_connect(ws: WebSocketServerProtocol, req: dict) -> dict:
    vid = req.get("vid", 0)
    pid = req.get("pid", 0)

    entry = next((d for d in DEVICES if d["vid"] == vid and d["pid"] == pid), None)
    if entry is None:
        return {"type": "usb_error", "message": f"Unknown device {vid:04x}:{pid:04x}"}

    use_sigrok = entry.get("sigrok", False)

    if use_sigrok:
        # sigrok-cli manages the device fully — don't touch it with pyusb at all
        # Re-read bus/address fresh at connect time so conn= is accurate
        _, bus, addr = _usb_device_present(vid, pid)
        state.device = None
        state.device_info = {**entry, "bus": bus, "address": addr}
        state.config.sigrok = True
        state.config.sigrok_driver = entry.get("sigrok_driver", "fx2lafw")
        state.config.mode = entry["mode"]
        log.info(f"Connected (sigrok mode): {entry['name']} bus={bus} addr={addr}")
        return {"type": "usb_connected", "device": entry["name"], "mode": entry["mode"]}

    # Direct pyusb path
    dev = usb.core.find(idVendor=vid, idProduct=pid)
    if dev is None:
        return {"type": "usb_error", "message": "Device not found"}

    if entry["needs_fw"] and entry["fw"]:
        fw_path = FIRMWARE_DIR / entry["fw"]
        if not fw_path.exists():
            return {"type": "usb_error", "message": f"Firmware not found: {fw_path}"}
        try:
            _upload_firmware(dev, fw_path)
            # Wait for the firmware-loaded PID (may differ from bare PID)
            rvid = entry.get("renumerate_vid", vid)
            rpid = entry.get("renumerate_pid", pid)
            dev = _wait_renumeration(rvid, rpid)
            if dev is None:
                return {"type": "usb_error", "message": "Device did not renumerate after firmware upload"}
        except Exception as e:
            return {"type": "usb_error", "message": f"Firmware upload failed: {e}"}

    try:
        dev.set_configuration()
    except Exception:
        pass

    # For DSO direct mode: detach kernel driver and claim interface
    # so ctrl_transfer and clear_halt work reliably
    if entry["mode"] == "dso":
        try:
            if dev.is_kernel_driver_active(0):
                dev.detach_kernel_driver(0)
        except Exception:
            pass
        try:
            usb.util.claim_interface(dev, 0)
        except Exception:
            pass

    state.device = dev
    state.device_info = entry
    state.config.sigrok = False
    state.config.sigrok_driver = ""
    state.config.mode = entry["mode"]
    log.info(f"Connected (direct mode): {entry['name']}")
    return {"type": "usb_connected", "device": entry["name"], "mode": entry["mode"]}


async def handle_usb_disconnect(_ws: WebSocketServerProtocol, _req: dict) -> dict:
    await _stop_capture()
    # Wait briefly for capture thread/process to fully release device
    await asyncio.sleep(0.2)
    if state.device is not None:
        try:
            usb.util.dispose_resources(state.device)
        except Exception:
            pass
        state.device = None
        state.device_info = None
    log.info("Disconnected")
    return {"type": "usb_disconnected"}


async def handle_usb_configure(_ws: WebSocketServerProtocol, req: dict) -> dict:
    state.config.sample_rate_hz  = req.get("sample_rate_hz", state.config.sample_rate_hz)
    state.config.sample_width    = req.get("sample_width", state.config.sample_width)
    state.config.sigrok          = req.get("sigrok", state.config.sigrok)
    state.config.sigrok_driver   = req.get("sigrok_driver", state.config.sigrok_driver)
    state.config.voltage_range = req.get("voltage_range", state.config.voltage_range)
    state.config.test_signal     = req.get("test_signal", state.config.test_signal)
    req_mode = req.get("mode", state.config.mode)
    state.config.mode = req_mode
    log.info(f"Configured: {state.config}")
    return {"type": "usb_configured"}


async def handle_usb_start(_ws: WebSocketServerProtocol, _req: dict) -> dict:
    t0 = time.monotonic()
    if state.capturing:
        # Previous capture still winding down — stop it first then continue
        log.info("Start requested while capturing — stopping previous capture first")
        await _stop_capture()
    if state.device is None and not state.config.sigrok:
        if not _reacquire_device():
            return {"type": "usb_error", "message": "Not connected"}

    state.stop_event.clear()
    state.capturing = True
    target = _capture_loop_sigrok if state.config.sigrok else _capture_loop_direct
    state.capture_thread = threading.Thread(target=target, daemon=True)
    state.capture_thread.start()
    elapsed = time.monotonic() - t0
    log.info(f"Capture started (sigrok={state.config.sigrok}) in {elapsed:.2f}s")
    return {"type": "usb_started"}


async def handle_usb_stop(_ws: WebSocketServerProtocol, _req: dict) -> dict:
    await _stop_capture()
    return {"type": "usb_stopped"}


async def handle_waveforge_firmware_get(_ws: WebSocketServerProtocol, _req: dict) -> dict:
    """Get current WaveForge firmware configuration."""
    status = get_waveforge_firmware_status()
    return {"type": "waveforge_firmware_status", "status": status}


async def handle_waveforge_firmware_set(ws: WebSocketServerProtocol, req: dict) -> dict:
    """Set WaveForge firmware mode (8ch or 16ch)."""
    mode = req.get("mode", "16ch")
    if mode not in ["8ch", "16ch"]:
        return {"type": "usb_error", "message": "Invalid mode. Use '8ch' or '16ch'"}
    
    # Stop any active capture before switching firmware
    if state.capturing:
        await _stop_capture()
    
    success = set_waveforge_firmware_link(mode)
    if success:
        status = get_waveforge_firmware_status()
        return {"type": "waveforge_firmware_set", "mode": mode, "status": status}
    else:
        return {"type": "usb_error", "message": f"Failed to set firmware mode to {mode}"}


async def handle_usb_diag(_ws: WebSocketServerProtocol, _req: dict) -> dict:
    """Return runtime diagnostics for memory/performance investigation."""
    import os
    mem = {}
    try:
        with open(f"/proc/{os.getpid()}/status") as f:
            for line in f:
                if line.startswith("VmRSS:") or line.startswith("VmSize:") or line.startswith("VmData:"):
                    mem[line.split(":", 1)[0].strip()] = line.split(":", 1)[1].strip()
    except Exception:
        pass
    return {
        "type": "usb_diag",
        "clients": len(state.clients),
        "capturing": state.capturing,
        "pending_text": _is_pending(_pending_text),
        "config": {
            "sample_rate_hz": state.config.sample_rate_hz,
            "sample_width": state.config.sample_width,
            "mode": state.config.mode,
            "sigrok": state.config.sigrok,
        },
        "memory": mem,
    }


async def handle_hantek_test_signal(_ws: WebSocketServerProtocol, req: dict) -> dict:
    """Set Hantek calibration pulse frequency.
    Supports full 32Hz–100kHz range with dynamic encoding per Ho-Ro LibUsbScope.py.
    Caller is responsible for stopping/restarting capture if it is running.
    """
    frequency = req.get("frequency", "off")
    name_to_hz = {
        "off": 0, "32 Hz": 32, "50 Hz": 50, "100 Hz": 100,
        "200 Hz": 200, "500 Hz": 500, "1 kHz": 1000, "2 kHz": 2000,
        "5 kHz": 5000, "10 kHz": 10000, "50 kHz": 50000, "100 kHz": 100000,
    }
    if frequency not in name_to_hz:
        return {"type": "usb_error", "message": f"Invalid frequency: {frequency}"}
    if state.config.sigrok:
        return {
            "type": "usb_error",
            "message": "Test signal not available via sigrok driver. Use direct USB mode for test signal support."
        }
    state.config.test_signal = frequency
    return {"type": "hantek_test_signal", "frequency": frequency}


async def _stop_capture() -> None:
    t0 = time.monotonic()
    if not state.capturing:
        return
    if state.sigrok_proc:
        import signal as _signal
        try:
            state.sigrok_proc.send_signal(_signal.SIGINT)
        except Exception:
            state.sigrok_proc.terminate()

    loop = asyncio.get_event_loop()

    def _teardown_rust():
        if not state.rust_proc:
            return
        try:
            state.rust_proc.terminate()
            try:
                state.rust_proc.wait(timeout=0.5)
            except Exception:
                state.rust_proc.kill()
                try:
                    state.rust_proc.wait(timeout=0.5)
                except Exception:
                    pass
        except Exception:
            pass

    if state.rust_proc:
        await loop.run_in_executor(None, _teardown_rust)

    state.stop_event.set()
    if state.capture_thread:
        await loop.run_in_executor(None, state.capture_thread.join, 2.0)
        state.capture_thread = None
    state.capturing = False
    state.rust_proc = None
    # Brief delay so OS releases USB interface before next claim
    await asyncio.sleep(0.1)
    elapsed = time.monotonic() - t0
    broadcast_sync({"type": "usb_stopped"})
    log.info(f"Capture stopped in {elapsed:.2f}s")


HANDLERS = {
    "usb_scan":                  handle_usb_scan,
    "usb_connect":               handle_usb_connect,
    "usb_disconnect":            handle_usb_disconnect,
    "usb_configure":             handle_usb_configure,
    "usb_start":                 handle_usb_start,
    "usb_stop":                  handle_usb_stop,
    "usb_diag":                  handle_usb_diag,
    "waveforge_firmware_get":    handle_waveforge_firmware_get,
    "waveforge_firmware_set":    handle_waveforge_firmware_set,
    "hantek_test_signal":        handle_hantek_test_signal,
}

# Operations that mutate server state (start/stop/connect/configure) are serialized
# to prevent overlapping stop/start races from the frontend.
_LOCKED_TYPES = {
    "usb_connect",
    "usb_disconnect",
    "usb_start",
    "usb_stop",
    "waveforge_firmware_set",
    "hantek_test_signal",
}
# Note: usb_configure is intentionally NOT locked — it only mutates state.config
# and must not block behind a long stop/start sequence. The frontend is responsible
# for stop/configure/start when it wants to apply settings to a running capture.

# ---------------------------------------------------------------------------
# WebSocket handler
# ---------------------------------------------------------------------------

async def ws_handler(ws: WebSocketServerProtocol) -> None:
    state.clients.add(ws)
    log.info(f"Client connected: {ws.remote_address}")
    try:
        async for raw in ws:
            try:
                req = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send(json.dumps({"type": "error", "message": "Invalid JSON"}))
                continue

            msg_type = req.get("type", "")
            req_id   = req.get("req_id")
            handler  = HANDLERS.get(msg_type)

            if handler is None:
                await ws.send(json.dumps({"type": "error", "message": f"Unknown type: {msg_type}"}))
                continue

            try:
                # Serialize state-changing ops so frontend cannot overlap stop/start/configure
                if msg_type in _LOCKED_TYPES:
                    log.info(f"[{msg_type}] waiting for state lock (req_id={req_id})")
                    async with _state_lock:
                        log.info(f"[{msg_type}] acquired state lock (req_id={req_id})")
                        resp = await handler(ws, req)
                        log.info(f"[{msg_type}] handler done (req_id={req_id})")
                else:
                    log.info(f"[{msg_type}] handler start (req_id={req_id})")
                    resp = await handler(ws, req)
                    log.info(f"[{msg_type}] handler done (req_id={req_id})")
                if req_id is not None:
                    resp["req_id"] = req_id
                await ws.send(json.dumps(resp))
                log.info(f"[{msg_type}] response sent (req_id={req_id})")
            except Exception as e:
                log.exception(f"Handler error for {msg_type}")
                err = {"type": "usb_error", "message": str(e)}
                if req_id is not None:
                    err["req_id"] = req_id
                await ws.send(json.dumps(err))

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        state.clients.discard(ws)
        log.info(f"Client disconnected: {ws.remote_address}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    global _loop
    _loop = asyncio.get_event_loop()
    host, port = "localhost", 8766
    log.info(f"WaveForge USB bridge starting on ws://{host}:{port}")
    async with websockets.serve(ws_handler, host, port, ping_interval=10, ping_timeout=20):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Shutting down")
