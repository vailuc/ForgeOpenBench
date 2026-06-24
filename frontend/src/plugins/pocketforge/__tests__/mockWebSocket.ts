/** Mock WebSocket pair for testing BridgeTransport without a real server.
 *  Simulates the pokit_server.py protocol (type-based messages with req_id). */

export interface MockWsMessage {
  type: string;
  req_id?: string;
  [key: string]: unknown;
}

export class MockWebSocketController {
  protected static _active: MockWebSocketController | null = null;

  /** The client-side mock WebSocket exposed to BridgeTransport */
  client: MockWebSocket | null = null;

  /** Server-side state */
  connected = false;
  deviceName = "";
  deviceAddress = "";
  subscriptions = new Set<string>();
  lastRpc: MockWsMessage | null = null;
  rpcCounts = new Map<string, number>();

  /** Call this before each test to install the mock */
  static install(): MockWebSocketController {
    const ctrl = new MockWebSocketController();
    MockWebSocketController._active = ctrl;
    // @ts-ignore replace global WebSocket with our mock constructor
    globalThis.WebSocket = ctrl._createMockWebSocketClass();
    return ctrl;
  }

  /** Call this after each test to restore the real WebSocket */
  static uninstall(): void {
    MockWebSocketController._active = null;
    // @ts-ignore restore original (undefined in jsdom)
    globalThis.WebSocket = undefined;
  }

  private _createMockWebSocketClass() {
    const ctrl = this;
    return class extends MockWebSocket {
      constructor(url: string | URL, _protocols?: string | string[]) {
        super(url.toString());
        ctrl.client = this;
        // Simulate async connection
        setTimeout(() => {
          if (ctrl.client === this) {
            this._setReadyState(1);
            this._triggerOpen();
            // Auto-send initial ble_state so BridgeTransport can proceed
            if (ctrl.connected && ctrl.deviceName) {
              ctrl.serverSend({ type: "ble_state", state: "connected", name: ctrl.deviceName, address: ctrl.deviceAddress });
            } else {
              ctrl.serverSend({ type: "ble_state", state: "disconnected" });
            }
          }
        }, 5);
      }
    };
  }

  /** Simulate server sending a message to the client */
  serverSend(msg: MockWsMessage): void {
    if (this.client) {
      this.client._triggerMessage(msg);
    }
  }

  /** Simulate the full connection flow: ble_state connected */
  simulateConnected(name = "Pokit Pro", address = "AA:BB:CC:DD:EE:FF"): void {
    this.connected = true;
    this.deviceName = name;
    this.deviceAddress = address;
    this.serverSend({ type: "ble_state", state: "connected", name, address });
  }

  /** Simulate disconnected state */
  simulateDisconnected(): void {
    this.connected = false;
    this.serverSend({ type: "ble_state", state: "disconnected" });
  }

  /** Handle incoming RPC and auto-respond based on message type */
  handleRpc(msg: MockWsMessage): void {
    this.lastRpc = msg;
    const type = msg.type;
    this.rpcCounts.set(type, (this.rpcCounts.get(type) || 0) + 1);
    const reqId = msg.req_id;
    if (!reqId) return;

    switch (msg.type) {
      case "ble_connect_last": {
        if (this.deviceAddress) {
          this.simulateConnected(this.deviceName, this.deviceAddress);
          this.serverSend({ type: "ble_connect_last_ok", req_id: reqId });
        } else {
          this.serverSend({ type: "ble_error", req_id: reqId, error: "No cached device" });
        }
        break;
      }
      case "ble_scan": {
        this.serverSend({
          type: "ble_scan_result",
          req_id: reqId,
          devices: [{ name: "Pokit Pro", address: "AA:BB:CC:DD:EE:FF" }],
        });
        break;
      }
      case "ble_connect": {
        const addr = msg.address as string;
        if (addr) {
          this.simulateConnected("Pokit Pro", addr);
          this.serverSend({ type: "ble_connect_ok", req_id: reqId });
        } else {
          this.serverSend({ type: "ble_error", req_id: reqId, error: "No address" });
        }
        break;
      }
      case "gatt_subscribe": {
        const char = msg.characteristic as string;
        if (char) this.subscriptions.add(char);
        this.serverSend({ type: "gatt_subscribed", req_id: reqId, characteristic: char });
        break;
      }
      case "gatt_unsubscribe": {
        const char = msg.characteristic as string;
        this.subscriptions.delete(char);
        this.serverSend({ type: "gatt_unsubscribed", req_id: reqId, characteristic: char });
        break;
      }
      case "gatt_read": {
        // Return base64 of [0x01, 0x02, 0x03]
        this.serverSend({ type: "gatt_read", req_id: reqId, data: "AQID" });
        break;
      }
      case "gatt_write": {
        this.serverSend({ type: "gatt_written", req_id: reqId });
        break;
      }
      default: {
        // Generic ack
        this.serverSend({ type: `${msg.type}_ok`, req_id: reqId });
      }
    }
  }
}

/** Minimal WebSocket mock with event emitters */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  private _listeners: Map<string, Set<EventListener>> = new Map();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const ctrl = (MockWebSocketController as unknown as typeof MockWebSocketController & { _active: MockWebSocketController | null })._active;
    if (!ctrl) return;
    try {
      const msg = JSON.parse(data as string) as MockWsMessage;
      if (msg.req_id) {
        ctrl.handleRpc(msg);
      }
    } catch {
      // ignore non-JSON
    }
  }

  close(): void {
    this.readyState = 3;
    const event = new CloseEvent("close", { wasClean: true, code: 1000 });
    this.onclose?.(event);
    this._emit("close", event);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this._listeners.get(type)?.delete(listener);
  }

  // Internal helpers for the controller to trigger events
  _setReadyState(state: number): void {
    this.readyState = state;
  }

  _triggerOpen(): void {
    const event = new Event("open");
    this.onopen?.(event);
    this._emit("open", event);
  }

  _triggerMessage(data: unknown): void {
    const event = new MessageEvent("message", { data: JSON.stringify(data) });
    this.onmessage?.(event);
    this._emit("message", event);
  }

  private _emit(type: string, event: Event): void {
    this._listeners.get(type)?.forEach((l) => l(event));
  }
}
