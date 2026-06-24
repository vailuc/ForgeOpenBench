/**
 * Shared enums, structs and range tables for Pokit devices.
 * Values mirror pcolby/dokit's QtPokit definitions.
 */

export enum PokitProduct {
  PokitMeter = 0,
  PokitPro = 1,
}

/** Multimeter / measurement modes (superset across services). */
export enum MeterMode {
  Idle = 0,
  DcVoltage = 1,
  AcVoltage = 2,
  DcCurrent = 3,
  AcCurrent = 4,
  Resistance = 5,
  Diode = 6,
  Continuity = 7,
  Temperature = 8,
  Capacitance = 9,
  ExternalTemperature = 10,
}

/** Status byte semantics for a multimeter Reading (context dependent). */
export enum MeterStatus {
  AutoRangeOff = 0,
  AutoRangeOn = 1,
  Error = 255,
}

export enum DeviceStatusCode {
  Idle = 0,
  MultimeterDcVoltage = 1,
  MultimeterAcVoltage = 2,
  MultimeterDcCurrent = 3,
  MultimeterAcCurrent = 4,
  MultimeterResistance = 5,
  MultimeterDiode = 6,
  MultimeterContinuity = 7,
  MultimeterTemperature = 8,
  DsoModeSampling = 9,
  LoggerModeSampling = 10,
}

/** Map DeviceStatusCode to physical switch position (V | A | Ω | idle). */
export function getSwitchPosition(code: DeviceStatusCode): "V" | "A" | "Ω" | "idle" | "logger" {
  switch (code) {
    case DeviceStatusCode.Idle:
      return "idle";
    case DeviceStatusCode.MultimeterDcVoltage:
    case DeviceStatusCode.MultimeterAcVoltage:
    case DeviceStatusCode.DsoModeSampling:
      return "V";
    case DeviceStatusCode.MultimeterDcCurrent:
    case DeviceStatusCode.MultimeterAcCurrent:
      return "A";
    case DeviceStatusCode.MultimeterResistance:
    case DeviceStatusCode.MultimeterDiode:
    case DeviceStatusCode.MultimeterContinuity:
    case DeviceStatusCode.MultimeterTemperature:
      return "Ω";
    case DeviceStatusCode.LoggerModeSampling:
      return "logger";
    default:
      return "idle";
  }
}

/** True if the switch is on the V position (includes DSO and Logger). */
export function isDsoPosition(code: DeviceStatusCode): boolean {
  return getSwitchPosition(code) === "V" || getSwitchPosition(code) === "logger";
}

export enum BatteryStatus {
  Low = 0,
  Good = 1,
}

/** DSO acquisition command. */
export enum DsoCommand {
  FreeRunning = 0,
  RisingEdgeTrigger = 1,
  FallingEdgeTrigger = 2,
  ResendData = 3,
}

export enum DsoStatus {
  Done = 0,
  Sampling = 1,
  Error = 255,
}

/** Data logger command. */
export enum LoggerCommand {
  Start = 0,
  Stop = 1,
  Refresh = 2,
}

export enum LoggerStatus {
  Done = 0,
  Sampling = 1,
  BufferFull = 2,
  Error = 255,
}

export const AUTO_RANGE = 255;

/** A selectable range entry for a given mode. */
export interface RangeOption {
  /** Range byte written to the device. */
  value: number;
  /** Human label. */
  label: string;
  /** Maximum value of the range in the mode's base unit (V, A, Ω, F). */
  max: number;
}

/** Pokit Pro range tables (range byte -> label/max). */
export const PokitProRanges = {
  voltage: [
    { value: 0, label: "250 mV", max: 0.25 },
    { value: 1, label: "2 V", max: 2 },
    { value: 2, label: "10 V", max: 10 },
    { value: 3, label: "30 V", max: 30 },
    { value: 4, label: "60 V", max: 60 },
    { value: 5, label: "125 V", max: 125 },
    { value: 6, label: "400 V", max: 400 },
    { value: 7, label: "600 V", max: 600 },
  ] as RangeOption[],
  current: [
    { value: 0, label: "500 µA", max: 0.0005 },
    { value: 1, label: "2 mA", max: 0.002 },
    { value: 2, label: "10 mA", max: 0.01 },
    { value: 3, label: "125 mA", max: 0.125 },
    { value: 4, label: "300 mA", max: 0.3 },
    { value: 5, label: "3 A", max: 3 },
    { value: 6, label: "10 A", max: 10 },
  ] as RangeOption[],
  resistance: [
    { value: 0, label: "30 Ω", max: 30 },
    { value: 1, label: "75 Ω", max: 75 },
    { value: 2, label: "400 Ω", max: 400 },
    { value: 3, label: "5 kΩ", max: 5e3 },
    { value: 4, label: "10 kΩ", max: 10e3 },
    { value: 5, label: "15 kΩ", max: 15e3 },
    { value: 6, label: "40 kΩ", max: 40e3 },
    { value: 7, label: "500 kΩ", max: 500e3 },
    { value: 8, label: "700 kΩ", max: 700e3 },
    { value: 9, label: "1 MΩ", max: 1e6 },
    { value: 10, label: "3 MΩ", max: 3e6 },
  ] as RangeOption[],
  capacitance: [
    { value: 0, label: "100 nF", max: 100e-9 },
    { value: 1, label: "10 µF", max: 10e-6 },
    { value: 2, label: "1 mF", max: 1e-3 },
  ] as RangeOption[],
} as const;

export const DsoRanges = {
  voltage: [
    { value: 0, label: "10 mV", max: 0.01 },
    { value: 1, label: "50 mV", max: 0.05 },
    { value: 2, label: "250 mV", max: 0.25 },
    { value: 3, label: "1 V", max: 1 },
    { value: 4, label: "2 V", max: 2 },
    { value: 5, label: "10 V", max: 10 },
    { value: 6, label: "30 V", max: 30 },
    { value: 7, label: "60 V", max: 60 },
    { value: 8, label: "125 V", max: 125 },
    { value: 9, label: "200 V", max: 200 },
  ] as RangeOption[],
  current: [
    { value: 0, label: "10 µA", max: 10e-6 },
    { value: 1, label: "100 µA", max: 100e-6 },
    { value: 2, label: "500 µA", max: 0.0005 },
    { value: 3, label: "2 mA", max: 0.002 },
    { value: 4, label: "10 mA", max: 0.01 },
    { value: 5, label: "125 mA", max: 0.125 },
    { value: 6, label: "300 mA", max: 0.3 },
    { value: 7, label: "1 A", max: 1 },
    { value: 8, label: "2 A", max: 2 },
  ] as RangeOption[],
} as const;

export const AUTO_RANGE_OPTION: RangeOption = {
  value: AUTO_RANGE,
  label: "Auto",
  max: 0,
};

/** Returns the range table appropriate for a measurement mode (Pokit Pro). */
export function rangesForMode(mode: MeterMode): RangeOption[] {
  switch (mode) {
    case MeterMode.DcVoltage:
    case MeterMode.AcVoltage:
      return PokitProRanges.voltage;
    case MeterMode.DcCurrent:
    case MeterMode.AcCurrent:
      return PokitProRanges.current;
    case MeterMode.Resistance:
      return PokitProRanges.resistance;
    case MeterMode.Capacitance:
      return PokitProRanges.capacitance;
    default:
      return [];
  }
}

/** Returns the DSO range table appropriate for a measurement mode. */
export function dsoRangesForMode(mode: MeterMode): RangeOption[] {
  switch (mode) {
    case MeterMode.DcVoltage:
    case MeterMode.AcVoltage:
      return DsoRanges.voltage;
    case MeterMode.DcCurrent:
    case MeterMode.AcCurrent:
      return DsoRanges.current;
    default:
      return [];
  }
}

/** Base SI unit for a mode (used by the value formatter). */
export function unitForMode(mode: MeterMode): string {
  switch (mode) {
    case MeterMode.DcVoltage:
    case MeterMode.AcVoltage:
    case MeterMode.Diode:
      return "V";
    case MeterMode.DcCurrent:
    case MeterMode.AcCurrent:
      return "A";
    case MeterMode.Resistance:
      return "Ω";
    case MeterMode.Capacitance:
      return "F";
    case MeterMode.Temperature:
    case MeterMode.ExternalTemperature:
      return "°C";
    case MeterMode.Continuity:
      return "";
    default:
      return "";
  }
}

export function modeLabel(mode: MeterMode): string {
  switch (mode) {
    case MeterMode.Idle:
      return "Idle";
    case MeterMode.DcVoltage:
      return "DC Voltage";
    case MeterMode.AcVoltage:
      return "AC Voltage";
    case MeterMode.DcCurrent:
      return "DC Current";
    case MeterMode.AcCurrent:
      return "AC Current";
    case MeterMode.Resistance:
      return "Resistance";
    case MeterMode.Diode:
      return "Diode";
    case MeterMode.Continuity:
      return "Continuity";
    case MeterMode.Temperature:
      return "Temperature";
    case MeterMode.Capacitance:
      return "Capacitance";
    case MeterMode.ExternalTemperature:
      return "Ext. Temperature";
    default:
      return "Unknown";
  }
}

/** Device characteristics (from the Status service). */
export interface DeviceCharacteristics {
  firmwareVersion: string;
  maximumVoltage: number;
  maximumCurrent: number;
  maximumResistance: number;
  maximumSamplingRate: number;
  samplingBufferSize: number;
  capabilityMask: number;
  macAddress: string;
}

export interface DeviceStatus {
  status: DeviceStatusCode;
  batteryVoltage: number;
  batteryStatus?: BatteryStatus;
}

export interface MeterReading {
  status: MeterStatus;
  value: number;
  mode: MeterMode;
  range: number;
}

export interface DsoMetadata {
  status: DsoStatus;
  scale: number;
  mode: MeterMode;
  range: number;
  samplingWindowUs: number;
  numberOfSamples: number;
  samplingRate: number;
}

export interface LoggerMetadata {
  status: LoggerStatus;
  scale: number;
  mode: MeterMode;
  range: number;
  updateIntervalMs: number;
  numberOfSamples: number;
  timestamp: number;
}

const SI_PREFIXES: { factor: number; symbol: string }[] = [
  { factor: 1e9, symbol: "G" },
  { factor: 1e6, symbol: "M" },
  { factor: 1e3, symbol: "k" },
  { factor: 1, symbol: "" },
  { factor: 1e-3, symbol: "m" },
  { factor: 1e-6, symbol: "µ" },
  { factor: 1e-9, symbol: "n" },
  { factor: 1e-12, symbol: "p" },
];

/** Format a value with an automatic SI prefix and unit, e.g. 3.300 V. */
export function formatSi(value: number, unit: string, sigFigs = 4): string {
  if (!Number.isFinite(value)) return `-- ${unit}`.trim();
  if (value === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(value);
  let chosen = SI_PREFIXES[SI_PREFIXES.length - 1];
  for (const p of SI_PREFIXES) {
    if (abs >= p.factor) { chosen = p; break; }
  }
  const scaled = value / chosen.factor;
  const text = scaled.toPrecision(sigFigs);
  const trimmed = parseFloat(text).toString();
  return `${trimmed} ${chosen.symbol}${unit}`.trim();
}

/** Rough Li-ion battery percentage (3.0–4.2 V). */
export function batteryPercent(voltage: number): number {
  return Math.max(0, Math.min(100, Math.round(((voltage - 3.0) / 1.2) * 100)));
}
