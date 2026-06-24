"""BLE bridge WebSocket handler.

Proxies GATT operations from browser to local Bluetooth adapter via bleak.
"""

import asyncio
import base64
import json
from typing import Any

from bleak import BleakClient, BleakScanner
from fastapi import WebSocket, WebSocketDisconnect

# Pokit Status service UUIDs (used to identify devices, not just name)
POKIT_STATUS_UUIDS = [
    "57d3a771-267c-4394-8872-78223e92aec4",  # Pokit Meter
    "57d3a771-267c-4394-8872-78223e92aec5",  # Pokit Pro
]

# Map subscription IDs to (client, service_uuid, char_uuid, handler)
_subs: dict[str, tuple[BleakClient, str, str, Any]] = {}
_client: BleakClient | None = None
_lock = asyncio.Lock()


async def _get_client() -> BleakClient:
    if _client is None or not _client.is_connected:
        raise RuntimeError("BLE client not connected")
    return _client


def _pop_req_id(payload: dict) -> tuple[dict, str | None]:
    """Extract and remove _reqId so it isn't treated as a BLE param."""
    req_id = payload.pop("_reqId", None)
    return payload, req_id


def _resp(req_id: str | None, data: dict) -> dict:
    """Attach _reqId to response payload so frontend RPC can resolve."""
    if req_id is not None:
        data["_reqId"] = req_id
    return data


async def handle_bridge_ws(websocket: WebSocket) -> None:
    global _client, _subs

    await websocket.accept()
    await websocket.send_json({"type": "bridge_ready"})

    try:
        while True:
            msg = await websocket.receive_text()
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "payload": {"message": "Invalid JSON"}})
                continue

            cmd = data.get("cmd")
            payload, req_id = _pop_req_id(data.get("payload", {}))

            try:
                if cmd == "scan":
                    pokit_devices: list[dict] = []
                    seen = set()
                    all_services = [s.lower() for s in POKIT_STATUS_UUIDS]

                    def _on_detect(device, advertisement_data):
                        name = (device.name or advertisement_data.local_name or "").lower()
                        uuids = [u.lower() for u in (advertisement_data.service_uuids or [])]
                        is_pokit = (
                            "pokit" in name
                            or any(u in all_services for u in uuids)
                        )
                        if is_pokit and device.address not in seen:
                            seen.add(device.address)
                            display_name = device.name or advertisement_data.local_name or "Pokit Device"
                            pokit_devices.append({"name": display_name, "address": device.address})

                    scanner = BleakScanner(_on_detect)
                    await scanner.start()
                    await asyncio.sleep(payload.get("timeout", 6.0))
                    await scanner.stop()

                    await websocket.send_json({
                        "type": "scan_result",
                        "payload": _resp(req_id, {"devices": pokit_devices}),
                    })

                elif cmd == "connect":
                    addr = payload.get("address")
                    async with _lock:
                        if _client and _client.is_connected:
                            await _client.disconnect()
                        _client = BleakClient(addr)
                        await _client.connect()
                        name = "Pokit"
                        if hasattr(_client, "_device_info") and isinstance(_client._device_info, dict):
                            name = _client._device_info.get("Name", "Pokit")
                        await websocket.send_json({
                            "type": "connected",
                            "payload": _resp(req_id, {"name": name}),
                        })

                elif cmd == "disconnect":
                    async with _lock:
                        for sid in list(_subs):
                            _, _, char, _ = _subs[sid]
                            if _client and _client.is_connected:
                                try:
                                    await _client.stop_notify(char)
                                except Exception:
                                    pass
                            del _subs[sid]
                        if _client:
                            await _client.disconnect()
                            _client = None
                    await websocket.send_json({"type": "disconnected", "payload": _resp(req_id, {})})

                elif cmd == "read":
                    char = payload["char_uuid"]
                    client = await _get_client()
                    raw = await client.read_gatt_char(char)
                    await websocket.send_json({
                        "type": "read_result",
                        "payload": _resp(req_id, {"value_base64": base64.b64encode(raw).decode()}),
                    })

                elif cmd == "write":
                    char = payload["char_uuid"]
                    value = base64.b64decode(payload["value_base64"])
                    client = await _get_client()
                    if payload.get("without_response"):
                        await client.write_gatt_char(char, value, response=False)
                    else:
                        await client.write_gatt_char(char, value)
                    await websocket.send_json({"type": "write_ok", "payload": _resp(req_id, {})})

                elif cmd == "subscribe":
                    sid = payload["id"]
                    char = payload["char_uuid"]
                    client = await _get_client()

                    def _make_handler(sub_id: str):
                        def _handler(_sender: Any, data: bytearray) -> None:
                            asyncio.create_task(
                                websocket.send_json({
                                    "type": "notify",
                                    "payload": {
                                        "id": sub_id,
                                        "value_base64": base64.b64encode(bytes(data)).decode(),
                                    },
                                })
                            )
                        return _handler

                    h = _make_handler(sid)
                    await client.start_notify(char, h)
                    _subs[sid] = (client, payload["service_uuid"], char, h)
                    await websocket.send_json({"type": "subscribed", "payload": _resp(req_id, {"id": sid})})

                elif cmd == "unsubscribe":
                    sid = payload["id"]
                    if sid in _subs:
                        _, _, char, h = _subs[sid]
                        if _client and _client.is_connected:
                            try:
                                await _client.stop_notify(char)
                            except Exception:
                                pass
                        del _subs[sid]
                    await websocket.send_json({"type": "unsubscribed", "payload": _resp(req_id, {"id": sid})})

                else:
                    await websocket.send_json({"type": "error", "payload": _resp(req_id, {"message": f"Unknown cmd: {cmd}"})})

            except Exception as e:
                await websocket.send_json({"type": "error", "payload": _resp(req_id, {"message": str(e)})})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.send_json({"type": "error", "payload": {"message": str(e)}})
    finally:
        async with _lock:
            for sid in list(_subs):
                _, _, char, _ = _subs[sid]
                if _client and _client.is_connected:
                    try:
                        await _client.stop_notify(char)
                    except Exception:
                        pass
                del _subs[sid]
