import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { meterSamplesRef, pushMeterSample, clearMeterSamples } from "./sharedMeterStore";

export interface LogSample {
  timestamp: number;
  value: number;
  unit: string;
  mode: string;
}

export interface LogStats {
  min: number;
  max: number;
  avg: number;
  count: number;
  span: number;
  snrDb: number | null;
  durationMs: number;
  rateHz: number; // effective sample rate
}

export function useLogger() {

  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const startTimeRef = useRef<number>(0);
  const pushCountRef = useRef(0);
  const lastSampleRef = useRef<LogSample | null>(null);

  // Snapshot state for React re-renders (throttled)
  const [statsSnapshot, setStatsSnapshot] = useState<LogStats | null>(null);
  const [lastSample, setLastSample] = useState<LogSample | null>(null);

  const recalcStats = useCallback(() => {
    const buf = meterSamplesRef.current;
    if (buf.length < 2) return;

    let min = buf[0].value;
    let max = buf[0].value;
    let sum = 0;
    for (const s of buf) {
      if (s.value < min) min = s.value;
      if (s.value > max) max = s.value;
      sum += s.value;
    }
    const avg = sum / buf.length;
    const span = max - min;
    const snrDb = span > 0 ? 20 * Math.log10(Math.abs(avg) / span) : null;
    const durationMs = buf[buf.length - 1].timestamp - buf[0].timestamp;
    const rateHz = durationMs > 0 ? (buf.length / (durationMs / 1000)) : 0;

    setStatsSnapshot({ min, max, avg, count: buf.length, span, snrDb, durationMs, rateHz });
  }, []);

  // Poll shared ref for new data pushed by Meter
  useEffect(() => {
    if (!isRunning || isPaused) return;
    const id = setInterval(() => {
      const buf = meterSamplesRef.current;
      if (buf.length === 0) return;
      const last = buf[buf.length - 1];
      if (last !== lastSampleRef.current) {
        lastSampleRef.current = last;
        setLastSample(last);
        pushCountRef.current++;
        if (pushCountRef.current % 10 === 0) recalcStats();
      }
    }, 100);
    return () => clearInterval(id);
  }, [isRunning, isPaused, recalcStats]);

  const push = useCallback((sample: LogSample) => {
    if (!isRunning || isPaused) return;
    pushMeterSample(sample);
    lastSampleRef.current = sample;
    setLastSample(sample);
    pushCountRef.current++;
    if (pushCountRef.current % 10 === 0) recalcStats();
  }, [isRunning, isPaused, recalcStats]);

  const start = useCallback(() => {
    startTimeRef.current = Date.now();
    pushCountRef.current = 0;
    setIsRunning(true);
    setIsPaused(false);
    // Don't clear data — Logger mirrors Meter's accumulated data
    recalcStats();
  }, [recalcStats]);

  const stop = useCallback(() => {
    setIsRunning(false);
    recalcStats();
  }, [recalcStats]);

  const pause = useCallback(() => {
    setIsPaused(true);
  }, []);

  const resume = useCallback(() => {
    setIsPaused(false);
  }, []);

  const reset = useCallback(() => {
    clearMeterSamples();
    startTimeRef.current = 0;
    pushCountRef.current = 0;
    lastSampleRef.current = null;
    setStatsSnapshot(null);
    setLastSample(null);
    setIsRunning(false);
    setIsPaused(false);
  }, []);

  const exportCsv = useCallback((): string => {
    const buf = meterSamplesRef.current;
    if (buf.length === 0) return "";
    const lines = ["timestamp,value,unit,mode"];
    for (const s of buf) {
      lines.push(`${s.timestamp},${s.value},${s.unit},${s.mode}`);
    }
    return lines.join("\n");
  }, []);

  const exportJson = useCallback((): string => {
    const buf = meterSamplesRef.current;
    return JSON.stringify({
      plugin: "pocketforge",
      type: "logger",
      startTime: startTimeRef.current,
      sampleCount: buf.length,
      samples: buf,
    }, null, 2);
  }, []);

  const download = useCallback((content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const saveToServer = useCallback(async () => {
    const buf = meterSamplesRef.current;
    if (buf.length === 0) return;
    const payload = {
      plugin: "pocketforge",
      name: `logger_${new Date().toISOString()}`,
      timestamp: Date.now(),
      value: buf[buf.length - 1].value,
      unit: buf[buf.length - 1].unit,
      meta: {
        mode: buf[buf.length - 1].mode,
        sampleCount: buf.length,
        durationMs: buf[buf.length - 1].timestamp - buf[0].timestamp,
      },
    };
    try {
      const resp = await fetch("/api/v1/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { ok: true, server: true };
    } catch {
      const key = `fob_logger_${Date.now()}`;
      localStorage.setItem(key, JSON.stringify(payload));
      return { ok: true, server: false, localKey: key };
    }
  }, []);

  const samples = useMemo(() => [...meterSamplesRef.current], [lastSample]);

  return {
    isRunning,
    isPaused,
    samples,
    stats: statsSnapshot,
    lastSample,
    push,
    start,
    stop,
    pause,
    resume,
    reset,
    exportCsv,
    exportJson,
    download,
    saveToServer,
  };
}
