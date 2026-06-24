import { ALL_SERVICE_UUIDS, StatusServiceUuids } from "./uuids";

export type ConnectionListener = (connected: boolean) => void;
export type NotifyHandler = (value: DataView) => void;

/** Shared contract for any Pokit transport (Web BT or bridge). */
export interface IPokitConnection {
  get isConnected(): boolean;
  get deviceName(): string;
  get canReconnect(): boolean;
  get wasIntentionalDisconnect(): boolean;
  onConnectionChange(listener: ConnectionListener): () => void;
  requestAndConnect(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): void;
  readCharacteristic(serviceUuid: string, charUuid: string): Promise<DataView>;
  writeCharacteristic(serviceUuid: string, charUuid: string, value: ArrayBuffer, withoutResponse?: boolean): Promise<void>;
  subscribeCharacteristic(serviceUuid: string, charUuid: string, handler: NotifyHandler): Promise<() => Promise<void>>;
}

export class BleTransport implements IPokitConnection {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private services = new Map<string, BluetoothRemoteGATTService>();
  private listeners = new Set<ConnectionListener>();
  private subs = new Map<string, Map<string, () => Promise<void>>>();
  private _intentionalDisconnect = false;
  // Pokit firmware (especially Pro) cannot handle concurrent GATT operations.
  // Queue every read/write/subscribe so only one ATT transaction is in flight at a time.
  private gattQueue: Promise<unknown> = Promise.resolve();

  static isAvailable(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  get isConnected(): boolean {
    return !!this.server?.connected;
  }

  get deviceName(): string {
    return this.device?.name ?? "Unknown";
  }

  /** Whether we have a previously-selected device we can silently reconnect to. */
  get canReconnect(): boolean {
    return !!this.device?.gatt;
  }

  /** Whether the most recent disconnect was user-initiated. */
  get wasIntentionalDisconnect(): boolean {
    return this._intentionalDisconnect;
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(connected: boolean): void {
    for (const l of this.listeners) l(connected);
  }

  async requestAndConnect(): Promise<void> {
    if (!BleTransport.isAvailable()) {
      throw new Error("Web Bluetooth not available. Use Chrome/Edge over HTTPS or localhost.");
    }
    this._intentionalDisconnect = false;

    this.device = await navigator.bluetooth.requestDevice({
      optionalServices: ALL_SERVICE_UUIDS as string[],
      filters: [
        { services: [StatusServiceUuids.pokitPro] },
        { services: [StatusServiceUuids.pokitMeter] },
        { namePrefix: "Pokit" },
      ],
    });
    this.device.addEventListener("gattserverdisconnected", () => this.handleDisconnect());

    const gatt = this.device.gatt;
    if (!gatt) throw new Error("Device has no GATT interface");

    this.server = await gatt.connect();
    this.emit(true);
  }

  async reconnect(): Promise<void> {
    if (!this.device?.gatt) throw new Error("No previous device");
    this._intentionalDisconnect = false;
    this.server = await this.device.gatt.connect();
    this.emit(true);
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    this.cleanup();
  }

  private cleanup(): void {
    // Stop all notifications
    for (const charMap of this.subs.values()) {
      for (const unsub of charMap.values()) {
        unsub().catch(() => {});
      }
    }
    this.subs.clear();
    this.services.clear();

    if (this.device?.gatt?.connected) {
      try { this.device.gatt.disconnect(); } catch { /* ignore */ }
    }
    this.server = null;
    this.emit(false);
  }

  private handleDisconnect(): void {
    this.services.clear();
    this.server = null;
    this.emit(false);
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.gattQueue.then(op, op);
    this.gattQueue = next.catch(() => {});
    return next;
  }

  private async getService(serviceUuid: string): Promise<BluetoothRemoteGATTService> {
    if (!this.server?.connected) throw new Error("GATT not connected");
    let svc = this.services.get(serviceUuid);
    if (!svc) {
      svc = await this.server.getPrimaryService(serviceUuid);
      this.services.set(serviceUuid, svc);
    }
    return svc;
  }

  async readCharacteristic(serviceUuid: string, charUuid: string): Promise<DataView> {
    return this.enqueue(async () => {
      const svc = await this.getService(serviceUuid);
      const ch = await svc.getCharacteristic(charUuid);
      return await ch.readValue();
    });
  }

  async writeCharacteristic(
    serviceUuid: string,
    charUuid: string,
    value: ArrayBuffer,
    withoutResponse = false,
  ): Promise<void> {
    return this.enqueue(async () => {
      const svc = await this.getService(serviceUuid);
      const ch = await svc.getCharacteristic(charUuid);
      if (withoutResponse && ch.properties.writeWithoutResponse) {
        await ch.writeValueWithoutResponse(value);
      } else {
        await ch.writeValueWithResponse(value);
      }
    });
  }

  async subscribeCharacteristic(
    serviceUuid: string,
    charUuid: string,
    handler: NotifyHandler,
  ): Promise<() => Promise<void>> {
    return this.enqueue(async () => {
      const svc = await this.getService(serviceUuid);
      const ch = await svc.getCharacteristic(charUuid);
      const onNotify = (e: Event) => {
        const target = e.target as BluetoothRemoteGATTCharacteristic;
        if (target.value) handler(target.value);
      };
      ch.addEventListener("characteristicvaluechanged", onNotify);
      await ch.startNotifications();

      const unsub = async () => {
        ch.removeEventListener("characteristicvaluechanged", onNotify);
        await this.enqueue(async () => { await ch.stopNotifications(); });
        this.subs.get(serviceUuid)?.delete(charUuid);
      };

      if (!this.subs.has(serviceUuid)) this.subs.set(serviceUuid, new Map());
      this.subs.get(serviceUuid)!.set(charUuid, unsub);
      return unsub;
    });
  }
}
