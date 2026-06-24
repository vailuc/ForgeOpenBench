import type { IPokitConnection } from "./BleTransport";
import { MultimeterServiceUuids } from "./uuids";
import { MeterMode, MeterStatus, type MeterReading } from "./types";
import { ByteReader, ByteWriter } from "./codec";

export interface MultimeterSettings {
  mode: MeterMode;
  range: number;
  updateIntervalMs: number;
}

export class MultimeterService {
  constructor(private readonly transport: IPokitConnection) {}

  private get serviceUuid(): string {
    return MultimeterServiceUuids.service;
  }

  private get chars() {
    return MultimeterServiceUuids.characteristics;
  }

  static encodeSettings(s: MultimeterSettings): ArrayBuffer {
    return new ByteWriter().u8(s.mode).u8(s.range).u32(s.updateIntervalMs).toBuffer();
  }

  static parseReading(view: DataView): MeterReading {
    if (view.byteLength < 7) {
      throw new Error(`Meter reading too short: ${view.byteLength} bytes (need >= 7)`);
    }
    const r = new ByteReader(view);
    const status = r.u8() as MeterStatus;
    let value = r.f32();
    const mode = r.u8() as MeterMode;
    const range = r.u8();
    // Some firmware variants send voltage/current in millivolts/milliamps.
    // Heuristic: if value is absurdly large for the mode, divide by 1000.
    if (mode === MeterMode.DcVoltage || mode === MeterMode.AcVoltage) {
      if (Math.abs(value) > 1000) value /= 1000;
    } else if (mode === MeterMode.DcCurrent || mode === MeterMode.AcCurrent) {
      if (Math.abs(value) > 10) value /= 1000;
    }
    return { status, value, mode, range };
  }

  async setSettings(settings: MultimeterSettings): Promise<void> {
    await this.transport.writeCharacteristic(
      this.serviceUuid,
      this.chars.settings,
      MultimeterService.encodeSettings(settings),
    );
  }

  async readReading(): Promise<MeterReading> {
    const view = await this.transport.readCharacteristic(this.serviceUuid, this.chars.reading);
    return MultimeterService.parseReading(view);
  }

  async onReading(handler: (reading: MeterReading) => void): Promise<() => Promise<void>> {
    return this.transport.subscribeCharacteristic(this.serviceUuid, this.chars.reading, (view) => {
      handler(MultimeterService.parseReading(view));
    });
  }
}
