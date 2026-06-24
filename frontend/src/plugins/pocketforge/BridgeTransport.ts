import type { ConnectionListener, NotifyHandler, IPokitConnection } from "./BleTransport";
import { wsUrl } from "../../core/ws_url";

/** Message from standalone pokit_server.py */
interface WsMsg {
  type: string;
  [key: string]: unknown;
}

/** Bridge transport — connects to standalone Python bleak server (default port 8765).
 *  Speaks the pokit_server.py protocol (type-based, not cmd/payload). */
export class BridgeTransport implements IPokitConnection {
  private ws: WebSocket | null = null;
  private listeners = new Set<ConnectionListener>();
  private notifyHandlers = new Map<string, NotifyHandler>(); // char_uuid -> handler
  private subscriptionCounts = new Map<string, number>(); // char_uuid -> refcount
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _deviceName = "";
  private _deviceAddress = "";
  private _connected = false;
  private _reqId = 0;
  private _intentionalDisconnect = false;
  private _notifyCount = 0;

  get isConnected(): boolean {
    return this._connected;
  }

  get deviceName(): string {
    return this._deviceName;
  }

  get canReconnect(): boolean {
    return !!this._deviceAddress;
  }

  get wasIntentionalDisconnect(): boolean {
    return this._intentionalDisconnect;
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(connected: boolean): void {
    this._connected = connected;
    for (const l of this.listeners) l(connected);
  }

  private nextId(): string {
    return `${++this._reqId}`;
  }

  private async rpc(type: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Bridge WS not connected");
    }
    const reqId = this.nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.ws!.send(JSON.stringify({ type, req_id: reqId, ...payload }));
    });
  }

  private handleMessage = (ev: MessageEvent): void => {
    let msg: WsMsg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const type = msg.type;

    // Connection state broadcasts
    if (type === "ble_state") {
      const state = msg.state as string;
      const name = msg.name as string | undefined;
      const address = msg.address as string | undefined;
      if (name) this._deviceName = name;
      if (address) this._deviceAddress = address;
      if (state === "connected") {
        this.emit(true);
      } else if (state === "disconnected") {
        this.emit(false);
        this._deviceName = "";
      }
      return;
    }

    // Notifications (routed by characteristic UUID)
    if (type === "gatt_notification") {
      const charUuid = msg.characteristic as string;
      const b64 = msg.data as string;
      const handler = this.notifyHandlers.get(charUuid);
      // DIAG: log every 10th notification so we can see if WS delivery stops
      this._notifyCount++;
      if (this._notifyCount % 10 === 1) {
        console.debug(`[BridgeTransport] notify #${this._notifyCount} char=${charUuid.slice(0, 8)} handler=${!!handler}`);
      }
      if (handler) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        handler(new DataView(bytes.buffer));
      }
      return;
    }

    // RPC responses (matched by req_id)
    const reqId = msg.req_id as string | undefined;
    if (reqId && this.pending.has(reqId)) {
      if (type === "ble_error" || type === "error") {
        const err = (msg.error as string) || (msg.message as string) || "Bridge error";
        this.pending.get(reqId)!.reject(new Error(err));
      } else {
        this.pending.get(reqId)!.resolve(msg);
      }
      this.pending.delete(reqId);
      return;
    }

    // Unsolicited errors
    if (type === "ble_error" || type === "error") {
      console.error("[BridgeTransport] Unsolicited error:", msg);
    }
  };

  async requestAndConnect(): Promise<void> {
    const url = wsUrl("/", 8765);
    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      const cleanup = (err?: Error) => {
        if (!resolved) {
          resolved = true;
          if (err) {
            console.warn("[BridgeTransport] requestAndConnect rejected:", err.message);
            reject(err);
          } else {
            console.info("[BridgeTransport] requestAndConnect resolved");
            resolve();
          }
        }
      };

      const onOpen = () => {
        console.info("[BridgeTransport] WS open");
        ws.onmessage = this.handleMessage;
        // After WS open, we wait for the server to tell us BLE state.
        // If already connected (server persisted device), resolve immediately.
        // Otherwise we scan + connect below.
      };

      const onError = (ev: Event) => {
        console.warn("[BridgeTransport] WS error", ev);
        if (!resolved) cleanup(new Error("Bridge WS failed"));
      };

      const onClose = (ev: CloseEvent) => {
        console.info(`[BridgeTransport] WS close code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
        if (!this._intentionalDisconnect) {
          this.emit(false);
        }
        if (!resolved) cleanup(new Error("Bridge WS closed unexpectedly"));
      };

      ws.onopen = onOpen;
      ws.onerror = onError;
      ws.onclose = onClose;

      // Timeout: reject if nothing good happens in 30s
      const timer = setTimeout(() => {
        if (!resolved) {
          ws.close();
          cleanup(new Error("Bridge connection timeout (30s)"));
        }
      }, 30000);

      // Once first ble_state arrives, decide whether we need to scan
      const checkStateAndProceed = async () => {
        if (this._connected) {
          clearTimeout(timer);
          cleanup();
          return;
        }
        try {
          // Fast path: try cached device (no scan, faster if server has config)
          try {
            await this.rpc("ble_connect_last", {});
            await new Promise((r) => setTimeout(r, 500));
            if (this._connected) {
              clearTimeout(timer);
              cleanup();
              return;
            }
          } catch {
            // Cached connect failed — fall through to scan
          }

          // Scan for Pokit devices
          const scanResult = (await this.rpc("ble_scan", {})) as { devices: Array<{ name: string; address: string }> };
          const devices = scanResult.devices ?? [];
          if (devices.length === 0) {
            throw new Error("No Pokit devices found");
          }
          // Connect to first found device (skip_disconnect since we just scanned it)
          const device = devices[0];
          await this.rpc("ble_connect", { address: device.address, skip_disconnect: true });
          // Wait a moment for ble_state to propagate
          await new Promise((r) => setTimeout(r, 500));
          if (this._connected) {
            clearTimeout(timer);
            cleanup();
          } else {
            throw new Error("BLE connect did not succeed");
          }
        } catch (e) {
          clearTimeout(timer);
          cleanup(e instanceof Error ? e : new Error(String(e)));
        }
      };

      // Override handleMessage temporarily to catch first ble_state, then proceed
      const originalHandler = this.handleMessage;
      let stateChecked = false;
      this.handleMessage = (ev: MessageEvent) => {
        originalHandler(ev);
        if (!stateChecked && this.ws) {
          stateChecked = true;
          // Give one tick for state to update, then proceed
          setTimeout(checkStateAndProceed, 100);
        }
      };

      // Restore original handler after resolution
      const restoreHandler = () => {
        this.handleMessage = originalHandler;
      };
      ws.addEventListener("close", restoreHandler);
      ws.addEventListener("error", restoreHandler);
    });
  }

  async reconnect(): Promise<void> {
    console.info(`[BridgeTransport] reconnect called, ws=${this.ws ? this.ws.readyState : "null"}`);
    this._intentionalDisconnect = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Server clears _active_subscriptions on every fresh connect, so we must
      // reset our refcounts too — otherwise subscriptionCounts stays at 1 and
      // the next gatt_subscribe call is silently skipped (count > 0 guard).
      this.subscriptionCounts.clear();
      this.notifyHandlers.clear();
      await this.rpc("ble_connect_last", {});
      // Wait up to 5s for the server to reconnect and broadcast ble_state: connected
      for (let i = 0; i < 50; i++) {
        if (this._connected) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Reconnect failed");
    } else {
      await this.requestAndConnect();
    }
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.notifyHandlers.clear();
    this.subscriptionCounts.clear();
    this.pending.clear();
    this.emit(false);
    this._deviceName = "";
  }

  async readCharacteristic(serviceUuid: string, charUuid: string): Promise<DataView> {
    const result = (await this.rpc("gatt_read", { service: serviceUuid, characteristic: charUuid })) as { data: string };
    const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    return new DataView(bytes.buffer);
  }

  async writeCharacteristic(
    serviceUuid: string,
    charUuid: string,
    value: ArrayBuffer,
    withoutResponse = false,
  ): Promise<void> {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(value)));
    await this.rpc("gatt_write", {
      service: serviceUuid,
      characteristic: charUuid,
      data: b64,
      without_response: withoutResponse,
    });
  }

  async subscribeCharacteristic(
    serviceUuid: string,
    charUuid: string,
    handler: NotifyHandler,
  ): Promise<() => Promise<void>> {
    this.notifyHandlers.set(charUuid, handler);
    const count = this.subscriptionCounts.get(charUuid) || 0;
    this.subscriptionCounts.set(charUuid, count + 1);
    if (count === 0) {
      // First subscription for this char — actually tell the server
      await this.rpc("gatt_subscribe", { service: serviceUuid, characteristic: charUuid });
    }
    return async () => {
      const newCount = (this.subscriptionCounts.get(charUuid) || 1) - 1;
      if (newCount <= 0) {
        this.subscriptionCounts.delete(charUuid);
        this.notifyHandlers.delete(charUuid);
        await this.rpc("gatt_unsubscribe", { service: serviceUuid, characteristic: charUuid });
      } else {
        this.subscriptionCounts.set(charUuid, newCount);
      }
    };
  }
}
