import asyncio
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import serial.tools.list_ports
from .serial_bridge import SerialBridge

log = logging.getLogger(__name__)

router = APIRouter()

# Registry of shared serial bridges keyed by port device path.
_bridges: dict[str, SerialBridge] = {}
_bridges_lock = asyncio.Lock()


async def _get_or_create_bridge(port: str, baud: int) -> SerialBridge:
    async with _bridges_lock:
        bridge = _bridges.get(port)
        if bridge is None or bridge.closed.is_set():
            bridge = SerialBridge(port, baud)
            await bridge.start()
            _bridges[port] = bridge
        return bridge


async def _release_bridge(bridge: SerialBridge, ws: WebSocket):
    async with _bridges_lock:
        has_clients = await bridge.remove_client(ws)
        if not has_clients:
            await bridge.stop()
            _bridges.pop(bridge.port, None)


@router.get("/api/v1/serial/ports")
async def list_serial_ports():
    """List available serial ports on the host system."""
    ports = serial.tools.list_ports.comports()
    real = [p for p in ports if p.hwid and p.hwid.upper() not in ("N/A", "")]
    return {
        "ports": [
            {
                "device": p.device,
                "description": p.description,
                "hwid": p.hwid,
            }
            for p in sorted(real, key=lambda p: p.device)
        ]
    }


@router.websocket("/api/v1/serial/stream")
async def serial_stream(websocket: WebSocket, port: str, baud: int = 115200):
    """
    Bidirectional serial WebSocket bridge.
    Query params: port=/dev/ttyUSB0, baud=115200
    Multiple clients may connect to the same port; they share the underlying serial connection.
    RX bytes forwarded as UTF-8 text frames (invalid bytes replaced).
    TX: text frames sent to serial port.
    """
    await websocket.accept()
    log.info(f"Serial stream client connecting: {port} @ {baud}")

    try:
        bridge = await _get_or_create_bridge(port, baud)
    except serial.SerialException as e:
        await websocket.send_text(f"[error] Cannot open {port}: {e}\n")
        await websocket.close()
        return

    if bridge.baud != baud:
        await websocket.send_text(f"[error] Port {port} already open at {bridge.baud} baud\n")
        await websocket.close()
        return

    if not await bridge.add_client(websocket):
        await websocket.send_text(f"[error] Port {port} bridge is closing\n")
        await websocket.close()
        return

    try:
        while True:
            msg = await websocket.receive_text()
            await bridge.write(msg.encode("utf-8", errors="replace"))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning(f"Serial TX error from client: {e}")
    finally:
        await _release_bridge(bridge, websocket)
