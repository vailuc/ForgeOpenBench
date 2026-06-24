// Minimal Web Bluetooth API type stubs for Forge PocketForge plugin
// Full spec: https://webbluetoothcg.github.io/web-bluetooth/

interface Bluetooth extends EventTarget {
  getAvailability(): Promise<boolean>;
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface RequestDeviceOptions {
  filters?: BluetoothLEScanFilter[];
  optionalServices?: (BluetoothServiceUUID | BluetoothServiceUUID[])[];
  acceptAllDevices?: boolean;
}

interface BluetoothLEScanFilter {
  name?: string;
  namePrefix?: string;
  services?: BluetoothServiceUUID[];
}

type BluetoothServiceUUID = number | string;

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name: string | null;
  readonly gatt: BluetoothRemoteGATTServer | null;
  addEventListener(type: "gattserverdisconnected", listener: EventListenerOrEventListenerObject): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface BluetoothRemoteGATTServer {
  readonly device: BluetoothDevice;
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
  getPrimaryServices(service?: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothRemoteGATTService {
  readonly device: BluetoothDevice;
  readonly uuid: string;
  getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(characteristic?: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

type BluetoothCharacteristicUUID = number | string;

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly service: BluetoothRemoteGATTService;
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
  readonly value: DataView | null;
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  writeValueWithoutResponse(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  addEventListener(type: "characteristicvaluechanged", listener: EventListenerOrEventListenerObject): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface BluetoothCharacteristicProperties {
  readonly broadcast: boolean;
  readonly read: boolean;
  readonly writeWithoutResponse: boolean;
  readonly write: boolean;
  readonly notify: boolean;
  readonly indicate: boolean;
  readonly authenticatedSignedWrites: boolean;
  readonly reliableWrite: boolean;
  readonly writableAuxiliaries: boolean;
}

interface Navigator {
  readonly bluetooth: Bluetooth;
}
