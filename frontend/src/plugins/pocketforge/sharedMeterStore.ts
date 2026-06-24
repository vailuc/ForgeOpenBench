export interface LogSample {
  timestamp: number;
  value: number;
  unit: string;
  mode: string;
}

export interface MeterState {
  rel: boolean;
  tare: boolean;
  hold: boolean;
}

export const meterSamplesRef: { current: LogSample[] } = { current: [] };
export const meterStateRef: { current: MeterState } = { current: { rel: false, tare: false, hold: false } };

export function pushMeterSample(sample: LogSample) {
  meterSamplesRef.current.push(sample);
  if (meterSamplesRef.current.length > 50000) {
    meterSamplesRef.current = meterSamplesRef.current.slice(-50000);
  }
}

export function setMeterState(state: Partial<MeterState>) {
  meterStateRef.current = { ...meterStateRef.current, ...state };
}

export function clearMeterSamples() {
  meterSamplesRef.current = [];
}
