import asyncio
import logging
from fastapi import WebSocket, WebSocketDisconnect
import serial

log = logging.getLogger(__name__)


class SerialBridge:
    """Shared serial port bridge that can fan out to multiple WebSocket clients."""

    def __init__(self, port: str, baud: int):
        self.port = port
        self.baud = baud
        self.ser = serial.Serial(port, baud, timeout=0)
        self.clients: set[WebSocket] = set()
        self.closed = asyncio.Event()
        self._lock = asyncio.Lock()
        self._rx_task: asyncio.Task | None = None

    async def start(self):
        self._rx_task = asyncio.create_task(self._rx_loop())

    async def stop(self):
        self.closed.set()
        if self._rx_task:
            self._rx_task.cancel()
            try:
                await self._rx_task
            except asyncio.CancelledError:
                pass
        self.ser.close()
        log.info(f"Serial stream closed: {self.port}")

    async def add_client(self, ws: WebSocket) -> bool:
        async with self._lock:
            if self.closed.is_set():
                return False
            self.clients.add(ws)
            return True

    async def remove_client(self, ws: WebSocket) -> bool:
        async with self._lock:
            self.clients.discard(ws)
            return bool(self.clients)

    async def _broadcast(self, text: str):
        async with self._lock:
            dead = []
            for ws in self.clients:
                try:
                    await ws.send_text(text)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)

    async def _rx_loop(self):
        loop = asyncio.get_event_loop()
        while not self.closed.is_set():
            try:
                waiting = await loop.run_in_executor(None, lambda: self.ser.in_waiting)
                if waiting > 0:
                    data = await loop.run_in_executor(None, self.ser.read, min(waiting, 4096))
                    text = data.decode("utf-8", errors="replace")
                    await self._broadcast(text)
                else:
                    await asyncio.sleep(0.01)
            except Exception as e:
                log.warning(f"Serial RX error on {self.port}: {e}")
                self.closed.set()
                break

    async def write(self, data: bytes):
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.ser.write, data)
