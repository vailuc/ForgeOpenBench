/* ── 1-2-5 stepped scales, real scope values ───────────────────────── */

// Volts per division: decades with 1-2-5 steps
export const VDIV_STEPS = [
  0.001, 0.002, 0.005,
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.5,
  1, 2, 5,
  10, 20, 50,
];

// Seconds per division: decades with 1-2-5 steps
export const SDIV_STEPS = [
  1e-9, 2e-9, 5e-9,          // ns
  1e-8, 2e-8, 5e-8,
  1e-7, 2e-7, 5e-7,
  1e-6, 2e-6, 5e-6,          // µs
  1e-5, 2e-5, 5e-5,
  1e-4, 2e-4, 5e-4,
  1e-3, 2e-3, 5e-3,          // ms
  1e-2, 2e-2, 5e-2,
  1e-1, 2e-1, 5e-1,
  1, 2, 5,                   // s
  10, 20, 50,
];

export function formatVDiv(v: number): string {
  if (v < 0.001) return `${(v * 1e6).toFixed(0)}µV/div`;
  if (v < 1)     return `${(v * 1e3).toFixed(v < 0.01 ? 1 : 0)}mV/div`;
  return `${v.toFixed(v < 10 ? 1 : 0)}V/div`;
}

export function formatSDiv(s: number): string {
  if (s < 1e-6) return `${(s * 1e9).toFixed(0)}ns/div`;
  if (s < 1e-3) return `${(s * 1e6).toFixed(s < 1e-5 ? 1 : 0)}µs/div`;
  if (s < 1)    return `${(s * 1e3).toFixed(s < 1e-2 ? 1 : 0)}ms/div`;
  return `${s.toFixed(s < 10 ? 1 : 0)}s/div`;
}

// Map V/div to hardware vpp (full-scale peak-to-peak voltage)
// Hardware ranges: ±5V (vpp=10), ±2.5V (vpp=5), ±1V (vpp=2), ±500mV (vpp=1)
export function vDivToVpp(vDiv: number): number {
  const targetVpp = vDiv * 10; // 10 divisions vertically
  // Pick smallest hardware range that covers target
  const hwRanges = [10.0, 5.0, 2.0, 1.0];
  for (const r of hwRanges) {
    if (r >= targetVpp) return r;
  }
  return hwRanges[0];
}

// Map s/div to window duration in ms (10 divisions horizontally)
export function sDivToWindowMs(sDiv: number): number {
  return sDiv * 10 * 1000; // 10 divisions * 1000 ms/s
}

// Hardware sample rates (from legacy)
export const SAMPLE_RATES_DSO = [
  { label: "48 MS/s",  hz: 48_000_000 },
  { label: "30 MS/s",  hz: 30_000_000 },
  { label: "24 MS/s",  hz: 24_000_000 },
  { label: "16 MS/s",  hz: 16_000_000 },
  { label: "15 MS/s",  hz: 15_000_000 },
  { label: "12 MS/s",  hz: 12_000_000 },
  { label: "10 MS/s",  hz: 10_000_000 },
  { label: "8 MS/s",   hz: 8_000_000 },
  { label: "6 MS/s",   hz: 6_000_000 },
  { label: "5 MS/s",   hz: 5_000_000 },
  { label: "4 MS/s",   hz: 4_000_000 },
  { label: "3 MS/s",   hz: 3_000_000 },
  { label: "2 MS/s",   hz: 2_000_000 },
  { label: "1 MS/s",  hz: 1_000_000 },
  { label: "500 kS/s", hz:   500_000 },
  { label: "200 kS/s", hz:   200_000 },
  { label: "100 kS/s", hz:   100_000 },
  { label: "50 kS/s",  hz:    50_000 },
  { label: "20 kS/s",  hz:    20_000 },
];

export const TEST_SIGNAL_FREQS: Record<string, number> = {
  "off":    0,
  "32 Hz":  32,
  "50 Hz":  50,
  "100 Hz": 100,
  "200 Hz": 200,
  "500 Hz": 500,
  "1 kHz":  1000,
  "2 kHz":  2000,
  "5 kHz":  5000,
  "10 kHz": 10000,
  "50 kHz": 50000,
  "100 kHz": 100000,
};

// Voltage ranges for hardware config
export const VOLT_RANGES = [
  { label: "±5 V",    vpp: 10.0, code: 1  },
  { label: "±2.5 V",  vpp: 5.0,  code: 2  },
  { label: "±1 V",    vpp: 2.0,  code: 5  },
  { label: "±500 mV", vpp: 1.0,  code: 10 },
];
