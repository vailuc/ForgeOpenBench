/**
 * Bluetooth Low Energy service & characteristic UUIDs for Pokit devices.
 *
 * Reverse-engineered / documented by the dokit project (pcolby/dokit, LGPL-3.0).
 * All UUIDs are 128-bit; Web Bluetooth requires lower-case string form.
 */

/** Standard Bluetooth SIG services that Pokit devices also expose. */
export const StandardUuids = {
  /** Generic Access. */
  genericAccess: 0x1800,
  /** Device Information service. */
  deviceInformation: 0x180a,
  /** Battery service (some firmwares). */
  battery: 0x180f,
} as const;

/** `Pokit Status` service — also used to detect/identify a Pokit device. */
export const StatusServiceUuids = {
  /** Pokit Meter status service. */
  pokitMeter: "57d3a771-267c-4394-8872-78223e92aec4",
  /** Pokit Pro status service. */
  pokitPro: "57d3a771-267c-4394-8872-78223e92aec5",
  characteristics: {
    deviceCharacteristics: "6974f5e5-0e54-45c3-97dd-29e4b5fb0849",
    status: "3dba36e1-6120-4706-8dfd-ed9c16e569b6",
    name: "7f0375de-077e-4555-8f78-800494509cc3",
    flashLed: "ec9bb1f3-05a9-4277-8dd0-60a7896f0d6e",
    torch: "aaf3f6d5-43d4-4a83-9510-dff3d858d4cc",
    buttonPress: "8fe5b5a9-b5b4-4a7b-8ff2-87224b970f89",
  },
} as const;

/** `Multimeter` service. */
export const MultimeterServiceUuids = {
  service: "e7481d2f-5781-442e-bb9a-fd4e3441dadc",
  characteristics: {
    settings: "53dc9a7a-bc19-4280-b76b-002d0e23b078",
    reading: "047d3559-8bee-423a-b229-4417fa603b90",
  },
} as const;

/** `DSO` (oscilloscope) service. */
export const DsoServiceUuids = {
  service: "1569801e-1425-4a7a-b617-a4f4ed719de6",
  characteristics: {
    settings: "a81af1b6-b8b3-4244-8859-3da368d2be39",
    metadata: "970f00ba-f46f-4825-96a8-153a5cd0cda9",
    reading: "98e14f8e-536e-4f24-b4f4-1debfed0a99e",
  },
} as const;

/** `DataLogger` service. */
export const LoggerServiceUuids = {
  service: "a5ff3566-1fd8-4e10-8362-590a578a4121",
  characteristics: {
    settings: "5f97c62b-a83b-46c6-b9cd-cac59e130a78",
    metadata: "9acada2e-3936-430b-a8f7-da407d97ca6e",
    reading: "3c669dab-fc86-411c-9498-4f9415049cc0",
  },
} as const;

/** Every service UUID we may want to access — must be passed to requestDevice. */
export const ALL_SERVICE_UUIDS: BluetoothServiceUUID[] = [
  StatusServiceUuids.pokitMeter,
  StatusServiceUuids.pokitPro,
  MultimeterServiceUuids.service,
  DsoServiceUuids.service,
  LoggerServiceUuids.service,
  StandardUuids.deviceInformation,
  StandardUuids.battery,
];
