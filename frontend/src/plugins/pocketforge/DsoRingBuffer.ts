/** Fixed-capacity ring buffer backed by Float64Array for zero-GC streaming. */
export class DsoRingBuffer {
  private buf: Float64Array;
  private count = 0;
  private head = 0;
  private totalPushed = 0;
  private _scale = 1;

  constructor(public capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  setScale(scale: number): void {
    this._scale = scale;
  }

  get length(): number { return this.count; }

  push(values: number[] | Float64Array): void {
    const n = values.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.head] = values[i];
      this.head = (this.head + 1) % this.capacity;
      if (this.count < this.capacity) this.count++;
    }
    this.totalPushed += n;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
    this.totalPushed = 0;
  }

  /** Get a copy of values in chronological order. */
  values(): Float64Array {
    const out = new Float64Array(this.count);
    if (this.count === 0) return out;
    const start = this.count < this.capacity
      ? 0
      : this.head;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % this.capacity] * this._scale;
    }
    return out;
  }

  /** Generate x array in ms based on sampleRate (Hz). Returns [0, dt, 2dt...] for fixed-window display. */
  xs(sampleRate: number): Float64Array {
    const dt = 1000 / sampleRate;
    const out = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = i * dt;
    }
    return out;
  }

  /** Convenience: returns [xs, ys] ready for uPlot setData(). */
  asArrays(sampleRate: number): [Float64Array, Float64Array] {
    return [this.xs(sampleRate), this.values()];
  }
}
