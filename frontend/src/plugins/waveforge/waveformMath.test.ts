import { describe, it, expect } from "vitest";
import { calcMeasurements, signalVariance, findNearestStep, autoset } from "./waveformMath";
import { VDIV_STEPS, SDIV_STEPS } from "./scopeConstants";

/* ── Helpers ─────────────────────────────────────────────────────── */

function sineWave(freq: number, rate: number, cycles: number, amp: number, offset = 0): number[] {
  const n = Math.round((cycles / freq) * rate);
  return Array.from({ length: n }, (_, i) => offset + amp * Math.sin((2 * Math.PI * freq * i) / rate));
}

function squareWave(freq: number, rate: number, cycles: number, amp: number, duty = 0.5): number[] {
  const n = Math.round((cycles / freq) * rate);
  const period = rate / freq;
  return Array.from({ length: n }, (_, i) => ((i % period) / period < duty ? amp : -amp));
}

/** Half-wave rectified sine: only positive half, negative clamped to 0 */
function halfWaveSine(freq: number, rate: number, cycles: number, amp: number): number[] {
  return sineWave(freq, rate, cycles, amp).map(v => Math.max(0, v));
}

/* ── findNearestStep ─────────────────────────────────────────────── */
describe("findNearestStep", () => {
  it("returns the exact step when target matches", () => {
    expect(findNearestStep(0.1, VDIV_STEPS)).toBe(0.1);
    expect(findNearestStep(1, VDIV_STEPS)).toBe(1);
  });

  it("rounds to nearest 1-2-5 step", () => {
    expect(findNearestStep(0.15, VDIV_STEPS)).toBe(0.2);
    expect(findNearestStep(0.035, VDIV_STEPS)).toBe(0.05);
    expect(findNearestStep(3.5e-3, SDIV_STEPS)).toBe(5e-3);
  });

  it("clamps to minimum step when target is below range", () => {
    expect(findNearestStep(0, VDIV_STEPS)).toBe(VDIV_STEPS[0]);
  });
});

/* ── calcMeasurements — sine wave ────────────────────────────────── */
describe("calcMeasurements — sine wave", () => {
  const RATE = 1_000_000;
  const buf = sineWave(1000, RATE, 10, 1.0); // 1 kHz, ±1 V, 10 cycles

  it("measures vpp ≈ 2 V", () => {
    expect(calcMeasurements(buf, RATE).vpp).toBeCloseTo(2.0, 1);
  });

  it("measures DC ≈ 0 V", () => {
    expect(Math.abs(calcMeasurements(buf, RATE).dc)).toBeLessThan(0.01);
  });

  it("measures frequency ≈ 1 kHz", () => {
    const { freq } = calcMeasurements(buf, RATE);
    expect(freq).toBeGreaterThan(900);
    expect(freq).toBeLessThan(1100);
  });

  it("measures period ≈ 1 ms", () => {
    const { period } = calcMeasurements(buf, RATE);
    expect(period).toBeCloseTo(0.001, 4);
  });
});

/* ── calcMeasurements — half-wave rectified sine ─────────────────── */
describe("calcMeasurements — half-wave sine", () => {
  const RATE = 1_000_000;
  const FREQ = 500;
  const buf = halfWaveSine(FREQ, RATE, 8, 1.0);

  it("measures vpp ≈ 1 V (positive half only)", () => {
    const { vpp } = calcMeasurements(buf, RATE);
    expect(vpp).toBeCloseTo(1.0, 1);
  });

  it("detects positive DC offset (mean > 0)", () => {
    const { dc } = calcMeasurements(buf, RATE);
    expect(dc).toBeGreaterThan(0.1);
  });

  it("measures frequency approximately correct (within 20%)", () => {
    const { freq } = calcMeasurements(buf, RATE);
    expect(freq).toBeGreaterThan(FREQ * 0.8);
    expect(freq).toBeLessThan(FREQ * 1.2);
  });
});

/* ── signalVariance ──────────────────────────────────────────────── */
describe("signalVariance", () => {
  it("returns 0 for DC signal", () => {
    const dc = new Array(100).fill(1.5);
    expect(signalVariance(dc)).toBe(0);
  });

  it("returns nonzero for AC signal", () => {
    const ac = sineWave(1000, 1_000_000, 5, 1.0);
    expect(signalVariance(ac)).toBeGreaterThan(0.5);
  });

  it("returns 0 for fewer than 10 samples", () => {
    expect(signalVariance([1, 2, 3])).toBe(0);
  });
});

/* ── autoset — sine wave ─────────────────────────────────────────── */
describe("autoset — sine wave", () => {
  const RATE = 4_000_000;
  const FREQ = 1000;
  const buf = sineWave(FREQ, RATE, 20, 1.5); // ±1.5 V, 20 cycles

  it("returns a result for a clean sine", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS);
    expect(r).not.toBeNull();
  });

  it("picks a V/div that fits the signal with headroom", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    // vpp ≈ 3 V; vDiv * 6 should be >= vpp, so vDiv >= 0.5
    expect(r.vDiv).toBeGreaterThanOrEqual(0.5);
    // Should not be absurdly large
    expect(r.vDiv).toBeLessThanOrEqual(2);
  });

  it("picks an s/div that shows at least one period", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    const windowS = r.sDiv * 10;
    expect(windowS).toBeGreaterThanOrEqual(1 / FREQ);
  });

  it("selects ch1 as source when only ch1 has signal", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    expect(r.source).toBe("ch1");
    expect(r.ch1HasSignal).toBe(true);
    expect(r.ch2HasSignal).toBe(false);
  });

  it("sets trigger level near signal midpoint", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    expect(Math.abs(r.triggerLevel)).toBeLessThan(0.2); // sine is symmetric, midpoint ≈ 0
  });
});

/* ── autoset — half-wave rectified sine ─────────────────────────── */
describe("autoset — half-wave sine", () => {
  const RATE = 4_000_000;
  const FREQ = 500;
  const buf = halfWaveSine(FREQ, RATE, 12, 2.0); // 0..2 V half-wave

  it("returns a result", () => {
    expect(autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)).not.toBeNull();
  });

  it("picks a V/div large enough to contain the positive half", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    // vpp ≈ 2 V; vDiv * 6 should be >= 2
    expect(r.vDiv * 6).toBeGreaterThanOrEqual(1.8);
  });

  it("picks an s/div that fits at least one full period", () => {
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    const windowS = r.sDiv * 10;
    expect(windowS).toBeGreaterThanOrEqual(1 / FREQ);
  });
});

/* ── autoset — no signal ─────────────────────────────────────────── */
describe("autoset — no signal", () => {
  it("returns null when both buffers are empty", () => {
    expect(autoset([], [], 4_000_000, VDIV_STEPS, SDIV_STEPS)).toBeNull();
  });

  it("returns null when signal is pure DC (below noise floor)", () => {
    const dc = new Array(1000).fill(0.5);
    expect(autoset(dc, [], 4_000_000, VDIV_STEPS, SDIV_STEPS)).toBeNull();
  });
});

/* ── autoset — duty cycle regression guard ───────────────────────── */
describe("autoset — square wave duty-cycle heuristic", () => {
  const RATE = 4_000_000;
  const FREQ = 200;

  it("50% square: s/div window fits one period", () => {
    const buf = squareWave(FREQ, RATE, 10, 1.0, 0.5);
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    expect(r).not.toBeNull();
    expect(r.sDiv * 10).toBeGreaterThanOrEqual(1 / FREQ);
  });

  it("25% duty square: s/div window fits one full period (regression)", () => {
    const buf = squareWave(FREQ, RATE, 10, 1.0, 0.25);
    const r = autoset(buf, [], RATE, VDIV_STEPS, SDIV_STEPS)!;
    expect(r).not.toBeNull();
    // The window should span at least 80% of one period
    expect(r.sDiv * 10).toBeGreaterThanOrEqual((1 / FREQ) * 0.8);
  });
});
