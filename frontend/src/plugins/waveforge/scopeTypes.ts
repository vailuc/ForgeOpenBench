/* ── Scope state types for hardware-style DSO layout ────────────────── */

export interface Measurements {
  vpp: number;
  dc: number;
  vrms: number;
  freq: number;
  period: number;
  riseTime: number;
  fallTime: number;
  dutyCycle: number;
  positiveWidth: number;
  negativeWidth: number;
}

export interface VerticalState {
  enabled: boolean;
  vDiv: number;        // volts per division, 1-2-5 sequence
  position: number;    // vertical offset in volts
  coupling: "dc" | "ac" | "gnd";
  probe: 1 | 10 | 100;
  invert: boolean;
  bwLimit: boolean;    // digital 20MHz lowpass
}

export interface HorizontalState {
  sDiv: number;       // seconds per division, 1-2-5 sequence
  position: number;    // horizontal delay in % (-50 to +50)
  acquireMode: "normal" | "peak" | "average";
  averageCount: number; // N frames for average mode
  rollMode: boolean;
}

export interface TriggerState {
  source: "ch1" | "ch2" | "ext" | "acline";
  level: number;       // volts
  slope: "rise" | "fall" | "both";
  mode: "auto" | "normal" | "single" | "smart";
  coupling: "dc" | "ac" | "hfrej" | "lfrej" | "noiserej";
  holdoff: number;     // seconds
}

export interface MathState {
  enabled: boolean;
  sourceA: "ch1" | "ch2";
  sourceB: "ch1" | "ch2";
  op: "add" | "sub" | "mul" | "div" | "fft" | "xy";
}

export type MeasurementKey =
  | "vpp" | "dc" | "vrms" | "freq" | "period"
  | "riseTime" | "fallTime" | "dutyCycle"
  | "positiveWidth" | "negativeWidth";

export const ALL_MEASUREMENT_KEYS: MeasurementKey[] = [
  "vpp", "dc", "vrms", "freq", "period",
  "riseTime", "fallTime", "dutyCycle",
  "positiveWidth", "negativeWidth",
];

export interface TraceSnapshot {
  mode: "time" | "xy";
  xs?: Float64Array;
  ys1: Float64Array;
  ys2: Float64Array;
  triggerOffset?: number;
  dt?: number;
}

export interface ScopePreset {
  name: string;
  createdAt: number;
  state: {
    ch1Vertical: VerticalState;
    ch2Vertical: VerticalState;
    horizontal: HorizontalState;
    trigger: TriggerState;
    math: MathState;
    phosphorEnabled: boolean;
    sampleRate: number;
  };
}
