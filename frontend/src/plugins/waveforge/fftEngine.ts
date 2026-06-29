export function fft(buf: number[]): { real: number[]; imag: number[] } {
  const n = buf.length;
  if (n === 0) return { real: [], imag: [] };
  const N = 1 << Math.ceil(Math.log2(n));
  const real = new Array(N).fill(0);
  const imag = new Array(N).fill(0);
  for (let i = 0; i < n; i++) real[i] = buf[i];
  // Bit-reversal permutation
  for (let i = 0, j = 0; i < N; i++) {
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; }
    let k = N >> 1;
    while (k & j) { j &= ~k; k >>= 1; }
    j |= k;
  }
  // Butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const wStepReal = Math.cos(-Math.PI / half);
    const wStepImag = Math.sin(-Math.PI / half);
    for (let i = 0; i < N; i += len) {
      let wReal = 1, wImag = 0;
      for (let j = 0; j < half; j++) {
        const uReal = real[i + j];
        const uImag = imag[i + j];
        const vReal = real[i + j + half] * wReal - imag[i + j + half] * wImag;
        const vImag = real[i + j + half] * wImag + imag[i + j + half] * wReal;
        real[i + j] = uReal + vReal;
        imag[i + j] = uImag + vImag;
        real[i + j + half] = uReal - vReal;
        imag[i + j + half] = uImag - vImag;
        const nextWReal = wReal * wStepReal - wImag * wStepImag;
        wImag = wReal * wStepImag + wImag * wStepReal;
        wReal = nextWReal;
      }
    }
  }
  return { real, imag };
}

export function fftMagnitude(buf: number[], sampleRate: number): { freqs: number[]; mags: number[] } {
  const { real, imag } = fft(buf);
  const N = real.length;
  const half = Math.floor(N / 2);
  const freqs: number[] = [];
  const mags: number[] = [];
  for (let i = 0; i < half; i++) {
    freqs.push(i * sampleRate / N);
    mags.push(Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / N);
  }
  return { freqs, mags };
}

export interface FftPeak {
  freq: number;
  mag: number;
  index: number;
}

export function findFftPeaks(
  freqs: number[],
  mags: number[],
  count = 5,
  minHz = 0,
  minBinDistance = 3
): FftPeak[] {
  const peaks: FftPeak[] = [];
  for (let i = 1; i < mags.length - 1; i++) {
    if (freqs[i] < minHz) continue;
    if (mags[i] > mags[i - 1] && mags[i] > mags[i + 1]) {
      peaks.push({ freq: freqs[i], mag: mags[i], index: i });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);
  const picked: FftPeak[] = [];
  for (const p of peaks) {
    if (picked.every(q => Math.abs(p.index - q.index) >= minBinDistance)) {
      picked.push(p);
    }
    if (picked.length >= count) break;
  }
  return picked.sort((a, b) => a.freq - b.freq);
}
