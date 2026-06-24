/** Sequential little-endian byte buffer builder. */
export class ByteWriter {
  private bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.bytes.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    );
    return this;
  }

  f32(value: number): this {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    this.bytes.push(...new Uint8Array(buf));
    return this;
  }

  toBuffer(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }

  get length(): number {
    return this.bytes.length;
  }
}

/** Sequential little-endian reader over a DataView. */
export class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(data: DataView | ArrayBuffer) {
    this.view = data instanceof DataView ? data : new DataView(data);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  get byteLength(): number {
    return this.view.byteLength;
  }

  u8(): number {
    if (this.offset + 1 > this.view.byteLength) throwByteError(this.offset, 1, this.view.byteLength);
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    if (this.offset + 2 > this.view.byteLength) throwByteError(this.offset, 2, this.view.byteLength);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    if (this.offset + 4 > this.view.byteLength) throwByteError(this.offset, 4, this.view.byteLength);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    if (this.offset + 4 > this.view.byteLength) throwByteError(this.offset, 4, this.view.byteLength);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i16(): number {
    if (this.offset + 2 > this.view.byteLength) throwByteError(this.offset, 2, this.view.byteLength);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  bytes(count: number): Uint8Array {
    if (this.offset + count > this.view.byteLength) throwByteError(this.offset, count, this.view.byteLength);
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint8(this.offset + i);
    this.offset += count;
    return out;
  }

  skip(count: number): this {
    if (this.offset + count > this.view.byteLength) throwByteError(this.offset, count, this.view.byteLength);
    this.offset += count;
    return this;
  }
}

function throwByteError(offset: number, need: number, length: number): never {
  throw new Error(`ByteReader overflow: need ${need} bytes at offset ${offset}, length ${length}`);
}

/** Format a 6-byte MAC address (read big-endian/display order) as a colon string. */
export function formatMac(bytes: Uint8Array): string {
  return Array.from(bytes)
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}
