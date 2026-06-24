/**
 * Fixed-capacity ring buffer for packed LA/DSO byte samples.
 * Oldest bytes are silently overwritten when full — no copyWithin,
 * no allocation after construction.
 */
export class RingBuffer {
  private buf: Uint8Array;
  private head = 0;   // write pointer (next byte to write)
  private _count = 0; // total bytes written (capped at capacity)

  constructor(readonly capacity: number) {
    this.buf = new Uint8Array(capacity);
  }

  get count(): number { return this._count; }
  get isFull(): boolean { return this._count === this.capacity; }

  /** Check if adding src would cause overflow */
  wouldOverflow(src: Uint8Array): boolean {
    return this._count + src.length > this.capacity;
  }

  /** Append bytes, overwriting oldest when full. */
  push(src: Uint8Array): void {
    const len = src.length;
    if (len === 0) return;

    if (len >= this.capacity) {
      // src larger than ring — keep only the last capacity bytes
      this.buf.set(src.subarray(len - this.capacity));
      this.head = 0;
      this._count = this.capacity;
      return;
    }

    const tail = this.capacity - this.head;
    if (len <= tail) {
      this.buf.set(src, this.head);
    } else {
      this.buf.set(src.subarray(0, tail), this.head);
      this.buf.set(src.subarray(tail), 0);
    }
    this.head = (this.head + len) % this.capacity;
    this._count = Math.min(this._count + len, this.capacity);
  }

  /** Return the last `n` bytes as a contiguous Uint8Array (copies only if wrapped). */
  tail(n: number): Uint8Array {
    const bytes = Math.min(n, this._count);
    if (bytes === 0) return new Uint8Array(0);

    const start = (this.head - bytes + this.capacity) % this.capacity;
    if (start + bytes <= this.capacity) {
      return this.buf.slice(start, start + bytes);
    }
    // Wraps around — must copy
    const out = new Uint8Array(bytes);
    const firstPart = this.capacity - start;
    out.set(this.buf.subarray(start), 0);
    out.set(this.buf.subarray(0, bytes - firstPart), firstPart);
    return out;
  }

  /** Return all buffered bytes in order (oldest first). */
  toArray(): Uint8Array {
    return this.tail(this._count);
  }

  reset(): void {
    this.head = 0;
    this._count = 0;
  }
}

/**
 * Enhanced ring buffer that splits to backend when full.
 * Maintains the same 8MB capacity but uploads chunks before overflow.
 */
export class SplittingRingBuffer extends RingBuffer {
  private splitCount = 0;
  private sessionId: string = '';
  private onSplit?: (chunk: Uint8Array, index: number, sessionId: string) => void;

  constructor(capacity: number, sessionId: string) {
    super(capacity);
    this.sessionId = sessionId;
  }

  get splits(): number { return this.splitCount; }

  /** Set callback for when buffer needs to split */
  setSplitCallback(callback: (chunk: Uint8Array, index: number, sessionId: string) => void): void {
    this.onSplit = callback;
  }

  /** Override push to check for overflow and split before overwrite */
  push(src: Uint8Array): void {
    if (src.length === 0) return;

    // Check if this push would cause overflow
    if (this.wouldOverflow(src)) {
      // Split current buffer before overflow
      this.performSplit();
    }

    // Now push the data (safe since we made room)
    super.push(src);
  }

  /** Perform the split operation */
  private performSplit(): void {
    if (this.count === 0) return; // Nothing to split

    // Get all current data
    const chunk = this.toArray();
    
    // Call the split callback
    if (this.onSplit) {
      this.onSplit(chunk, this.splitCount, this.sessionId);
    }

    // Reset buffer for next chunk
    this.reset();
    this.splitCount++;
  }

  /** Force split of current buffer content */
  forceSplit(): void {
    this.performSplit();
  }

  /** Reset split count and session */
  resetSession(newSessionId?: string): void {
    this.splitCount = 0;
    if (newSessionId) {
      this.sessionId = newSessionId;
    }
    this.reset();
  }
}
