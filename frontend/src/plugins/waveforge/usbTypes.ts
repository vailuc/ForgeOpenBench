export type UsbCaptureMode = "la" | "dso";

export interface UsbDeviceInfo {
  vid: number;
  pid: number;
  name: string;
  mode: UsbCaptureMode;
  needs_fw: boolean;
  fw: string | null;
  address?: number;
  bus?: number;
}

export interface UsbConfig {
  mode: UsbCaptureMode;
  sample_rate_hz: number;
  sample_width: 8 | 16;
  voltage_range?: number; // Vpp for DSO mode (5, 2.5, 1, 0.5)
  test_signal?: string; // "off", "1kHz", "10kHz", "100kHz"
  sigrok?: boolean;
  sigrok_driver?: string;
}

export interface UsbDataChunk {
  mode: UsbCaptureMode;
  ts: number;
  rate: number;
  width: 8 | 16;
  samples: number;
  b64: string;
  data?: Uint8Array; // raw binary from Rust native capture (no base64)
}

export type UsbDataHandler = (chunk: UsbDataChunk) => void;
export type UsbConnectionListener = (connected: boolean) => void;
