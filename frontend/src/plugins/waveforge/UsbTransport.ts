import type {
  UsbDeviceInfo, UsbConfig, UsbDataChunk,
  UsbDataHandler, UsbConnectionListener,
} from "./usbTypes";
import { wsUrl } from "../../core/ws_url";

const USB_BRIDGE_URL = wsUrl("/", 8766);
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 5_000;
const CONNECT_WAIT_MS   = 15_000;

export class UsbTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<UsbConnectionListener>();
  private dataHandlers = new Set<UsbDataHandler>();
  private stopHandlers = new Set<() => void>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _connected = false;
  private _reqId = 0;
  private _intentionalDisconnect = false;
  private _reconnectDelay = RECONNECT_BASE_MS;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _deviceInfo: UsbDeviceInfo | null = null;

  get isConnected(): boolean { return this._connected; }
  get deviceInfo(): UsbDeviceInfo | null { return this._deviceInfo; }
  get wasIntentionalDisconnect(): boolean { return this._intentionalDisconnect; }

  connect(): void {
    this._intentionalDisconnect = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectDelay = RECONNECT_BASE_MS;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this._openWs();
  }

  private _waitForConnected(timeoutMs = CONNECT_WAIT_MS): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Timeout waiting for usb_server connection"));
      }, timeoutMs);
      const off = this.onConnectionChange((online) => {
        if (online) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      this.connect();
    });
  }

  private _openWs(): void {
    this.ws = new WebSocket(USB_BRIDGE_URL);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this._reconnectDelay = RECONNECT_BASE_MS;
      this._connected = true;
      this.listeners.forEach((l) => l(true));
    };

    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this._handleMessage(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        this._handleBinary(ev.data);
      }
    };

    this.ws.onclose = () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._rejectAllPending();
      if (wasConnected) this.listeners.forEach((l) => l(false));
      if (!this._intentionalDisconnect) this._scheduleReconnect();
    };

    this.ws.onerror = () => { /* onclose fires after */ };
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openWs();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  private _handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    const type = msg.type as string;

    if (type === "usb_data") {
      const chunk = msg as unknown as UsbDataChunk;
      this.dataHandlers.forEach(h => h(chunk));
      return;
    }

    if (type === "usb_stopped") {
      this.stopHandlers.forEach(h => h());
      return;
    }

    const reqId = msg.req_id as string | undefined;
    if (reqId && this.pending.has(reqId)) {
      const { resolve, reject } = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      if (type === "usb_error") reject(new Error(msg.message as string));
      else resolve(msg);
    }
  }

  private _lastFrameUs: number = 0;
  private _chunkCount = 0;
  private _chunkBytes = 0;
  private _chunkRateT0 = 0;

  private _handleBinary(buf: ArrayBuffer): void {
    // Binary frame format from Rust hantek-capture:
    // [0..3]   msg_len: u32 (little-endian, total message bytes)
    // [4..7]   rate_hz: u32
    // [8..11]  n_bytes: u32
    // [12..19] timestamp_us: u64 (Rust capture time, for latency diag)
    // [20..23] reserved: u32
    // [24..]   raw USB bulk data
    if (buf.byteLength < 24) return;
    const view = new DataView(buf);
    const rate = view.getUint32(4, true);
    const nBytes = view.getUint32(8, true);
    const data = new Uint8Array(buf, 24, Math.min(nBytes, buf.byteLength - 24));
    // Log inter-frame interval (browser wall time) to detect stalls
    const nowUs = performance.now() * 1000;
    const intervalUs = this._lastFrameUs ? nowUs - this._lastFrameUs : 0;
    this._lastFrameUs = nowUs;
    if (intervalUs > 100_000) { // log if >100ms
      // eslint-disable-next-line no-console
      console.log(`[UsbTransport] frame interval: ${(intervalUs / 1000).toFixed(1)}ms`);
    }
    // Chunk-rate diagnostics
    const nowMs = performance.now();
    if (this._chunkRateT0 === 0) this._chunkRateT0 = nowMs;
    this._chunkCount++;
    this._chunkBytes += nBytes;
    if (nowMs - this._chunkRateT0 >= 1000) {
      // eslint-disable-next-line no-console
      console.log(`[UsbTransport] chunk rate: ${this._chunkCount}/s, ${this._chunkBytes} bytes/s, avg ${(this._chunkBytes / this._chunkCount).toFixed(0)} bytes/chunk`);
      this._chunkCount = 0;
      this._chunkBytes = 0;
      this._chunkRateT0 = nowMs;
    }

    const chunk: UsbDataChunk = {
      mode: "dso",
      ts: performance.now() / 1000,
      rate,
      width: 8,
      samples: nBytes, // raw byte count (interleaved CH1/CH2)
      b64: "", // not used in binary mode
      data,
    };
    this.dataHandlers.forEach(h => h(chunk));
  }

  private _rejectAllPending(): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error("WS disconnected"));
    }
    this.pending.clear();
  }

  private async _rpc(type: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this._waitForConnected();
    }
    const req_id = `r${++this._reqId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        // A timeout likely means the connection is half-open; force reconnect.
        this.ws?.close();
        reject(new Error(`RPC timeout: ${type}`));
      }, timeoutMs);
      this.pending.set(req_id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws!.send(JSON.stringify({ type, req_id, ...params }));
    });
  }

  async scan(): Promise<UsbDeviceInfo[]> {
    const r = await this._rpc("usb_scan") as { devices: UsbDeviceInfo[] };
    return r.devices;
  }

  async connectDevice(device: UsbDeviceInfo): Promise<string> {
    const params: Record<string, unknown> = { vid: device.vid, pid: device.pid };
    if (device.bus !== undefined)     params.bus     = device.bus;
    if (device.address !== undefined) params.address = device.address;
    const r = await this._rpc("usb_connect", params, 20_000) as { device: string; mode: string };
    this._deviceInfo = { ...device, name: r.device, mode: r.mode as "la" | "dso" };
    return r.device;
  }

  async disconnectDevice(): Promise<void> {
    await this._rpc("usb_disconnect");
    this._deviceInfo = null;
  }

  async configure(cfg: UsbConfig): Promise<void> {
    await this._rpc("usb_configure", cfg as unknown as Record<string, unknown>);
  }

  async sendTestSignal(frequency: string): Promise<void> {
    await this._rpc("hantek_test_signal", { frequency });
  }

  async start(): Promise<void> {
    await this._rpc("usb_start");
  }

  async stop(): Promise<void> {
    await this._rpc("usb_stop");
  }

  onData(handler: UsbDataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => { this.dataHandlers.delete(handler); };
  }

  onStopped(handler: () => void): () => void {
    this.stopHandlers.add(handler);
    return () => { this.stopHandlers.delete(handler); };
  }

  onConnectionChange(listener: UsbConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
