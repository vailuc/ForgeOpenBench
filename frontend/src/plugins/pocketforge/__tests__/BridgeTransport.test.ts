import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BridgeTransport } from "../BridgeTransport";
import { MockWebSocketController } from "./mockWebSocket";

describe("BridgeTransport", () => {
  let transport: BridgeTransport;
  let ctrl: MockWebSocketController;

  beforeEach(() => {
    ctrl = MockWebSocketController.install();
    transport = new BridgeTransport();
  });

  afterEach(() => {
    transport.disconnect();
    MockWebSocketController.uninstall();
  });

  describe("connection", () => {
    it("connects via fast path when server has cached device", async () => {
      ctrl.deviceName = "Pokit Pro";
      ctrl.deviceAddress = "AA:BB:CC:DD:EE:FF";

      const connectPromise = transport.requestAndConnect();

      // wait for WebSocket open + ble_state check
      await new Promise((r) => setTimeout(r, 50));

      await connectPromise;

      expect(transport.isConnected).toBe(true);
      expect(transport.deviceName).toBe("Pokit Pro");
      expect(ctrl.lastRpc?.type).toBe("ble_connect_last");
    });

    it("falls back to scan + connect when cached device fails", async () => {
      // No cached device
      const connectPromise = transport.requestAndConnect();

      await new Promise((r) => setTimeout(r, 50));

      // Server sends ble_state disconnected (no cached device)
      ctrl.simulateDisconnected();

      await new Promise((r) => setTimeout(r, 50));

      await connectPromise;

      expect(transport.isConnected).toBe(true);
      expect(transport.deviceName).toBe("Pokit Pro");
      expect(ctrl.lastRpc?.type).toBe("ble_connect");
      // ble_scan was sent before ble_connect
    });

    it("emits connection state changes", async () => {
      const states: boolean[] = [];
      transport.onConnectionChange((connected) => states.push(connected));

      ctrl.deviceAddress = "AA:BB:CC:DD:EE:FF";
      await transport.requestAndConnect();
      await new Promise((r) => setTimeout(r, 20));

      expect(states).toContain(true);
    });

    it("disconnect() clears all state", async () => {
      ctrl.deviceAddress = "AA:BB:CC:DD:EE:FF";
      await transport.requestAndConnect();
      await new Promise((r) => setTimeout(r, 20));

      expect(transport.isConnected).toBe(true);

      transport.disconnect();

      expect(transport.isConnected).toBe(false);
      expect(transport.deviceName).toBe("");
    });
  });

  describe("GATT operations", () => {
    beforeEach(async () => {
      ctrl.deviceAddress = "AA:BB:CC:DD:EE:FF";
      await transport.requestAndConnect();
      await new Promise((r) => setTimeout(r, 20));
    });

    it("reads a characteristic", async () => {
      const data = await transport.readCharacteristic(
        "0000180a-0000-1000-8000-00805f9b34fb",
        "2a29"
      );
      expect(data.byteLength).toBe(3);
      expect(new Uint8Array(data.buffer)).toEqual(new Uint8Array([1, 2, 3]));
      expect(ctrl.lastRpc?.type).toBe("gatt_read");
    });

    it("writes a characteristic", async () => {
      await transport.writeCharacteristic(
        "0000180a-0000-1000-8000-00805f9b34fb",
        "2a29",
        new Uint8Array([0xab, 0xcd]).buffer
      );
      expect(ctrl.lastRpc?.type).toBe("gatt_write");
    });

    it("subscribes and routes notifications", async () => {
      const notifications: DataView[] = [];
      const handler = (dv: DataView) => notifications.push(dv);

      const unsub = await transport.subscribeCharacteristic(
        "0000180a-0000-1000-8000-00805f9b34fb",
        "2a29",
        handler
      );

      expect(ctrl.subscriptions.has("2a29")).toBe(true);
      expect(ctrl.lastRpc?.type).toBe("gatt_subscribe");

      // Simulate server notification (base64 of [0xde, 0xad])
      ctrl.serverSend({
        type: "gatt_notification",
        characteristic: "2a29",
        data: "3q0=",
      });

      expect(notifications.length).toBe(1);
      expect(new Uint8Array(notifications[0].buffer)).toEqual(
        new Uint8Array([0xde, 0xad])
      );

      await unsub();
      expect(ctrl.subscriptions.has("2a29")).toBe(false);
      expect(ctrl.lastRpc?.type).toBe("gatt_unsubscribe");
    });

    it("deduplicates subscriptions (refcounting)", async () => {
      const unsub1 = await transport.subscribeCharacteristic(
        "svc",
        "char1",
        () => {}
      );
      expect(ctrl.subscriptions.has("char1")).toBe(true);
      expect(ctrl.rpcCounts.get("gatt_subscribe")).toBe(1);

      // Second subscription to same char — should NOT send gatt_subscribe again
      const unsub2 = await transport.subscribeCharacteristic(
        "svc",
        "char1",
        () => {}
      );
      expect(ctrl.rpcCounts.get("gatt_subscribe")).toBe(1);

      // First unsubscribe should NOT send gatt_unsubscribe (refcount still 1)
      await unsub1();
      expect(ctrl.rpcCounts.get("gatt_unsubscribe") || 0).toBe(0);
      expect(ctrl.subscriptions.has("char1")).toBe(true);

      // Second unsubscribe SHOULD send gatt_unsubscribe
      await unsub2();
      expect(ctrl.subscriptions.has("char1")).toBe(false);
      expect(ctrl.rpcCounts.get("gatt_unsubscribe")).toBe(1);
    });
  });

  describe("error handling", () => {
    it("rejects read when not connected", async () => {
      await expect(
        transport.readCharacteristic("svc", "char")
      ).rejects.toThrow("Bridge WS not connected");
    });

    it("rejects write when not connected", async () => {
      await expect(
        transport.writeCharacteristic("svc", "char", new Uint8Array([1]).buffer)
      ).rejects.toThrow("Bridge WS not connected");
    });
  });
});
