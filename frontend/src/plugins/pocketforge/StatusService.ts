/**
 * Pokit `Status` service: device characteristics, live status/battery,
 * device name, flash-LED and torch control.
 */

import type { IPokitConnection } from "./BleTransport";
import { ByteReader, formatMac } from "./codec";
import { StatusServiceUuids } from "./uuids";
import {
  BatteryStatus,
  DeviceStatusCode,
  type DeviceCharacteristics,
  type DeviceStatus,
} from "./types";

export class StatusService {
  constructor(
    private readonly transport: IPokitConnection,
    private readonly serviceUuid: string,
  ) {}

  private get chars() {
    return StatusServiceUuids.characteristics;
  }

  /** Read static device characteristics (firmware, limits, MAC). */
  async readDeviceCharacteristics(): Promise<DeviceCharacteristics> {
    const view = await this.transport.readCharacteristic(this.serviceUuid, this.chars.deviceCharacteristics);
    if (view.byteLength < 20) {
      throw new Error(`Device characteristics too short: ${view.byteLength} bytes (need >= 20)`);
    }
    const r = new ByteReader(view);
    const fwMajor = r.u8();
    const fwMinor = r.u8();
    const maximumVoltage = r.u16();
    const maximumCurrent = r.u16();
    const maximumResistance = r.u16();
    const maximumSamplingRate = r.u16();
    const samplingBufferSize = r.u16();
    const capabilityMask = r.u16();
    const macAddress = formatMac(r.bytes(6));
    return {
      firmwareVersion: `${fwMajor}.${fwMinor}`,
      maximumVoltage,
      maximumCurrent,
      maximumResistance,
      maximumSamplingRate,
      samplingBufferSize,
      capabilityMask,
      macAddress,
    };
  }

  private parseStatus(view: DataView): DeviceStatus {
    const r = new ByteReader(view);
    const status = r.u8() as DeviceStatusCode;
    const batteryVoltage = r.f32();
    let batteryStatus: BatteryStatus | undefined;
    if (r.remaining >= 1) batteryStatus = r.u8() as BatteryStatus;
    return { status, batteryVoltage, batteryStatus };
  }

  /** Read current device status + battery. */
  async readStatus(): Promise<DeviceStatus> {
    const view = await this.transport.readCharacteristic(this.serviceUuid, this.chars.status);
    return this.parseStatus(view);
  }

  /** Subscribe to status notifications. Returns unsubscribe fn. */
  async onStatus(handler: (status: DeviceStatus) => void): Promise<() => Promise<void>> {
    return this.transport.subscribeCharacteristic(this.serviceUuid, this.chars.status, (view) => {
      if (view.byteLength === 0) return; // Some firmware sends empty keepalive notifications
      handler(this.parseStatus(view));
    });
  }

  /** Read the device name (e.g. "Pokit Pro"). */
  async readName(): Promise<string> {
    const view = await this.transport.readCharacteristic(this.serviceUuid, this.chars.name);
    return new TextDecoder().decode(view);
  }

  /** Rename the device. */
  async setName(name: string): Promise<void> {
    const data = new TextEncoder().encode(name);
    await this.transport.writeCharacteristic(this.serviceUuid, this.chars.name, data.buffer as ArrayBuffer);
  }

  /** Flash the device's status LED. */
  async flashLed(): Promise<void> {
    await this.transport.writeCharacteristic(
      this.serviceUuid,
      this.chars.flashLed,
      new Uint8Array([1]).buffer,
      true,
    );
  }

  /** Toggle the torch (undocumented characteristic; Pokit Pro only). */
  async setTorch(on: boolean): Promise<void> {
    await this.transport.writeCharacteristic(
      this.serviceUuid,
      this.chars.torch,
      new Uint8Array([on ? 1 : 0]).buffer,
      true,
    );
  }

  /**
   * Subscribe to physical button presses (undocumented characteristic).
   */
  async onButtonPress(handler: (raw: Uint8Array) => void): Promise<() => Promise<void>> {
    return this.transport.subscribeCharacteristic(this.serviceUuid, this.chars.buttonPress, (view) => {
      const bytes = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      handler(bytes);
    });
  }
}
