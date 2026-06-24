export interface WaveformMetrics {
  min: number;
  max: number;
  peakToPeak: number;
  mean: number;
  rms: number;
  frequency: number;
  period: number;
  dutyCycle: number;
}

export function computeMetrics(values: number[], sampleRate: number): WaveformMetrics {
  const n = values.length;
  if (n === 0) {
    return { min: 0, max: 0, peakToPeak: 0, mean: 0, rms: 0, frequency: 0, period: 0, dutyCycle: 0 };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const rms = Math.sqrt(sumSq / n);
  const peakToPeak = max - min;
  const mid = (max + min) / 2;

  const crossings: number[] = [];
  let aboveCount = 0;
  for (let i = 1; i < n; i++) {
    if (values[i - 1] <= mid && values[i] > mid) {
      const t = (mid - values[i - 1]) / (values[i] - values[i - 1] || 1);
      crossings.push(i - 1 + t);
    }
    if (values[i] > mid) aboveCount++;
  }

  let frequency = 0;
  let period = 0;
  if (crossings.length >= 2 && sampleRate > 0) {
    let totalGap = 0;
    for (let i = 1; i < crossings.length; i++) totalGap += crossings[i] - crossings[i - 1];
    const avgGapSamples = totalGap / (crossings.length - 1);
    if (avgGapSamples > 0) {
      period = avgGapSamples / sampleRate;
      frequency = 1 / period;
    }
  }

  const dutyCycle = n > 1 ? aboveCount / (n - 1) : 0;

  return { min, max, peakToPeak, mean, rms, frequency, period, dutyCycle };
}
