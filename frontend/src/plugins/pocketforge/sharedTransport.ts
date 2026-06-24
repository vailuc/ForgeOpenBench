import type { IPokitConnection } from "./BleTransport";

let _transport: IPokitConnection | null = null;
let _metaUnsub: (() => Promise<void>) | null = null;
let _sampleUnsub: (() => Promise<void>) | null = null;

export function getSharedTransport(): IPokitConnection | null { return _transport; }
export function setSharedTransport(t: IPokitConnection | null): void { _transport = t; }

export function getSharedMetaUnsub(): (() => Promise<void>) | null { return _metaUnsub; }
export function setSharedMetaUnsub(u: (() => Promise<void>) | null): void { _metaUnsub = u; }

export function getSharedSampleUnsub(): (() => Promise<void>) | null { return _sampleUnsub; }
export function setSharedSampleUnsub(u: (() => Promise<void>) | null): void { _sampleUnsub = u; }

let _meterBusy = false;
export function getSharedMeterBusy(): boolean { return _meterBusy; }
export function setSharedMeterBusy(v: boolean): void { _meterBusy = v; }
