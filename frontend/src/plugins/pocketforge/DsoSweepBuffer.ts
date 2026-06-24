/** Fixed-capacity sweep buffer: writes left-to-right, commits on wrap. */
export class DsoSweepBuffer {
  private buf: Float64Array;
  private head = 0;
  private _scale = 1;
  private history: Float64Array[] = [];

  constructor(public capacity: number, public maxHistory = 3) {
    this.buf = new Float64Array(capacity);
  }

  setScale(scale: number): void { this._scale = scale; }

  push(values: number[] | Float64Array): void {
    const n = values.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.head] = values[i];
      this.head++;
      if (this.head >= this.capacity) {
        this.commit();
        this.head = 0;
      }
    }
  }

  commit(): void {
    const copy = new Float64Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) copy[i] = this.buf[i] * this._scale;
    this.history.unshift(copy);
    if (this.history.length > this.maxHistory) this.history.pop();
  }

  clear(): void {
    this.head = 0;
    this.buf.fill(0);
    this.history = [];
  }

  get current(): Float64Array {
    if (this.head === 0 && this.history.length > 0) {
      return this.history[0];
    }
    const out = new Float64Array(this.head);
    for (let i = 0; i < this.head; i++) out[i] = this.buf[i] * this._scale;
    return out;
  }

  get historyTraces(): Float64Array[] { return this.history; }

  xs(sampleRate: number): Float64Array {
    if (this.head === 0 && this.history.length > 0) {
      return this.fullXs(sampleRate);
    }
    const dt = 1000 / sampleRate;
    const out = new Float64Array(this.head);
    for (let i = 0; i < this.head; i++) out[i] = i * dt;
    return out;
  }

  /** Full width xs for history traces (same length as capacity). */
  fullXs(sampleRate: number): Float64Array {
    const dt = 1000 / sampleRate;
    const out = new Float64Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) out[i] = i * dt;
    return out;
  }
}
