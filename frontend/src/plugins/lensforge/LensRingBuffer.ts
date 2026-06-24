import { DsoRingBuffer } from "../pocketforge/DsoRingBuffer";

/**
 * Frame timestamp ring buffer — reuses DsoRingBuffer to track the last N
 * frame arrival times (ms) and compute live FPS.
 */
export class LensRingBuffer extends DsoRingBuffer {
  constructor(capacity = 60) {
    super(capacity);
  }

  /** Push current timestamp and return FPS over the last N frames. */
  pushFrame(): number {
    this.push([performance.now()]);
    return this.fps();
  }

  fps(): number {
    const vals = this.values();
    if (vals.length < 2) return 0;
    const span = vals[vals.length - 1] - vals[0];
    if (span <= 0) return 0;
    return Math.round(((vals.length - 1) / span) * 1000);
  }
}
