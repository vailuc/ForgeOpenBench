import type { Measurements } from "./scopeTypes";

export function calcMeasurements(buf: number[], rate: number): Measurements {
  if (buf.length < 2) {
    return {
      vpp: 0, dc: 0, vrms: 0, freq: 0, period: 0,
      riseTime: 0, fallTime: 0, dutyCycle: 0,
      positiveWidth: 0, negativeWidth: 0,
    };
  }

  let min = buf[0], max = buf[0], sum = 0, sumSq = 0;
  for (const v of buf) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const dc = sum / buf.length;
  const vpp = max - min;

  // Zero-crossing frequency
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] <= dc && buf[i] > dc) || (buf[i - 1] >= dc && buf[i] < dc)) crossings++;
  }
  const period = crossings > 0 ? (buf.length / rate) / (crossings / 2) : 0;
  const freq = period > 0 ? 1 / period : 0;

  // Duty cycle + pulse widths using 50% threshold
  const threshold = (min + max) / 2;
  let posTime = 0, negTime = 0;
  for (let i = 1; i < buf.length; i++) {
    const dt = 1 / rate;
    if (buf[i] > threshold) posTime += dt;
    else negTime += dt;
  }
  const totalTime = posTime + negTime;
  const dutyCycle = totalTime > 0 ? (posTime / totalTime) * 100 : 0;
  const positiveWidth = freq > 0 ? dutyCycle / 100 * period : 0;
  const negativeWidth = freq > 0 ? (1 - dutyCycle / 100) * period : 0;

  // Rise/fall time: 10% → 90% and 90% → 10% of first crossing
  const low = min + vpp * 0.1;
  const high = min + vpp * 0.9;
  let riseTime = 0, fallTime = 0;
  let inRise = false, inFall = false;
  let riseStart = 0, fallStart = 0;

  for (let i = 0; i < buf.length; i++) {
    if (!inRise && buf[i] <= low && i + 1 < buf.length && buf[i + 1] > low) {
      inRise = true; riseStart = i;
    }
    if (inRise && buf[i] >= high) {
      riseTime = (i - riseStart) / rate;
      inRise = false;
    }
    if (!inFall && buf[i] >= high && i + 1 < buf.length && buf[i + 1] < high) {
      inFall = true; fallStart = i;
    }
    if (inFall && buf[i] <= low) {
      fallTime = (i - fallStart) / rate;
      inFall = false;
    }
  }

  return {
    vpp, dc, vrms: Math.sqrt(sumSq / buf.length),
    freq, period, riseTime, fallTime, dutyCycle,
    positiveWidth, negativeWidth,
  };
}

export function signalVariance(buf: number[]): number {
  if (buf.length < 10) return 0;
  const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
  return Math.sqrt(buf.reduce((a, b) => a + (b - mean) ** 2, 0) / buf.length);
}

export function findNearestStep(target: number, steps: number[]): number {
  if (steps.length === 0) return target;
  let best = steps[0];
  let bestDiff = Math.abs(Math.log10(target) - Math.log10(steps[0]));
  for (const s of steps) {
    const diff = Math.abs(Math.log10(target) - Math.log10(s));
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

export function autoset(
  ch1Buf: number[], ch2Buf: number[], rate: number,
  vDivSteps: number[], sDivSteps: number[]
) {
  const ch1Var = signalVariance(ch1Buf);
  const ch2Var = signalVariance(ch2Buf);
  const NOISE_FLOOR = 0.01;
  const hasCh1 = ch1Buf.length >= 10 && ch1Var > NOISE_FLOOR;
  const hasCh2 = ch2Buf.length >= 10 && ch2Var > NOISE_FLOOR;
  const useCh1 = hasCh1 || (!hasCh2 && ch1Buf.length > ch2Buf.length);
  const buf = useCh1 ? ch1Buf : ch2Buf;
  if (buf.length < 10) return null;

  const vpp = Math.max(...buf) - Math.min(...buf);
  const targetVDiv = vpp / 5;
  const vDiv = findNearestStep(Math.max(targetVDiv, vDivSteps[0]), vDivSteps);

  const m = calcMeasurements(buf, rate);
  const period = m.period || 0.001;
  const targetSDiv = period / 3;
  const sDiv = findNearestStep(Math.max(targetSDiv, sDivSteps[0]), sDivSteps);

  const triggerLevel = (Math.max(...buf) + Math.min(...buf)) / 2;

  return {
    vDiv,
    sDiv,
    triggerLevel,
    source: useCh1 ? "ch1" : "ch2" as "ch1" | "ch2",
    ch1HasSignal: hasCh1,
    ch2HasSignal: hasCh2,
  };
}
