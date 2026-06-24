import type { IPokitConnection } from "./BleTransport";
import { DsoServiceUuids } from "./uuids";
import { ByteReader, ByteWriter } from "./codec";
import { DsoCommand, DsoStatus, MeterMode, type DsoMetadata } from "./types";

export interface DsoSettings {
  command: DsoCommand;
  triggerLevel: number;
  mode: MeterMode;
  range: number;
  samplingWindowUs: number;
  numberOfSamples: number;
}

export class DsoService {
  constructor(private readonly transport: IPokitConnection) {}

  private get serviceUuid(): string {
    return DsoServiceUuids.service;
  }

  private get chars() {
    return DsoServiceUuids.characteristics;
  }

  static encodeSettings(s: DsoSettings): ArrayBuffer {
    return new ByteWriter()
      .u8(s.command)
      .f32(s.triggerLevel)
      .u8(s.mode)
      .u8(s.range)
      .u32(s.samplingWindowUs)
      .u16(s.numberOfSamples)
      .toBuffer();
  }

  static parseMetadata(view: DataView): DsoMetadata {
    if (view.byteLength < 17) {
      throw new Error(`DSO metadata too short: ${view.byteLength} bytes (need >= 17)`);
    }
    const r = new ByteReader(view);
    return {
      status: r.u8() as DsoStatus,
      scale: r.f32(),
      mode: r.u8() as MeterMode,
      range: r.u8(),
      samplingWindowUs: r.u32(),
      numberOfSamples: r.u16(),
      samplingRate: r.u32(),
    };
  }

  static parseSamples(view: DataView): number[] {
    const r = new ByteReader(view);
    const out: number[] = [];
    while (r.remaining >= 2) out.push(r.i16());
    return out;
  }

  async setSettings(settings: DsoSettings): Promise<void> {
    await this.transport.writeCharacteristic(
      this.serviceUuid,
      this.chars.settings,
      DsoService.encodeSettings(settings),
    );
  }

  async startDso(settings: DsoSettings): Promise<void> {
    await this.setSettings(settings);
  }

  async readMetadata(): Promise<DsoMetadata> {
    const view = await this.transport.readCharacteristic(this.serviceUuid, this.chars.metadata);
    return DsoService.parseMetadata(view);
  }

  async onMetadata(handler: (meta: DsoMetadata) => void): Promise<() => Promise<void>> {
    return this.transport.subscribeCharacteristic(this.serviceUuid, this.chars.metadata, (view) =>
      handler(DsoService.parseMetadata(view)),
    );
  }

  async onSamples(handler: (samples: number[]) => void): Promise<() => Promise<void>> {
    return this.transport.subscribeCharacteristic(this.serviceUuid, this.chars.reading, (view) =>
      handler(DsoService.parseSamples(view)),
    );
  }
}

const DEFAULT_STALE_MS = 500;

export class DsoCaptureBuffer {
  private raw: number[] = [];
  private lastPushTime = 0;
  private _scale: number;
  private _staleMs = DEFAULT_STALE_MS;

  constructor(private expected: number, scale: number) {
    this._scale = scale;
    this.lastPushTime = Date.now();
  }

  reset(expected: number, scale: number): void {
    this.raw = [];
    this.expected = expected;
    this._scale = scale;
    this._staleMs = DEFAULT_STALE_MS;
    this.lastPushTime = Date.now();
  }

  updateScale(expected: number, scale: number, sampleRate?: number): void {
    this.expected = expected;
    this._scale = scale;
    if (sampleRate && sampleRate > 0) {
      this._staleMs = Math.max(DEFAULT_STALE_MS, (expected / sampleRate) * 1000 * 2);
    }
  }

  push(samples: number[]): void {
    this.lastPushTime = Date.now();
    this.raw.push(...samples);
  }

  get isComplete(): boolean {
    return this.raw.length >= this.expected;
  }

  get isStale(): boolean {
    return !this.isComplete && Date.now() - this.lastPushTime > this._staleMs;
  }

  get count(): number {
    return this.raw.length;
  }

  get scale(): number {
    return this._scale;
  }

  trim(keep: number): void {
    if (this.raw.length > keep) {
      this.raw = this.raw.slice(-keep);
    }
  }

  values(): number[] {
    return this.raw.map((s) => s * this.scale);
  }
}
