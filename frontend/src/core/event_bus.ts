/**
 * EventBus — WebSocket control plane client for FOB.
 * Handles JSON control messages: settings_get, settings_set, settings_ack, etc.
 */

import { wsUrl } from "./ws_url";

export type ControlMessage =
  | { type: "settings_snapshot"; payload: Record<string, unknown> }
  | { type: "settings_ack"; status: "success" | "error"; key?: string; reason?: string }
  | { type: "unknown_command_error" };

export type OutgoingMessage =
  | { type: "settings_update"; key: string; payload: Record<string, unknown> };

export class EventBus {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners: ((msg: ControlMessage) => void)[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(url = wsUrl("/api/v1/control", 8000)) {
    this.url = url;
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      console.warn("[EventBus] connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ControlMessage;
        this.listeners.forEach((fn) => fn(msg));
      } catch {
        console.warn("[EventBus] Non-JSON message:", event.data);
      }
    };

    this.ws.onclose = () => {
      this.reconnectAttempt++;
      const delay = Math.min(3000 * 2 ** (this.reconnectAttempt - 1), 30000);
      console.warn(`[EventBus] disconnected — retrying in ${delay / 1000}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };

    this.ws.onerror = (err) => {
      console.error("[EventBus] Error:", err);
    };
  }

  send(msg: OutgoingMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn("[EventBus] Cannot send — not connected");
    }
  }

  onMessage(fn: (msg: ControlMessage) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export const eventBus = new EventBus();
