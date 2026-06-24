import { UsbTransport } from "./UsbTransport";

let _transport: UsbTransport | null = null;

export function getSharedUsbTransport(): UsbTransport {
  if (!_transport) {
    _transport = new UsbTransport();
    _transport.connect();
  }
  return _transport;
}

export function resetSharedUsbTransport(): void {
  _transport?.disconnect();
  _transport = null;
}
