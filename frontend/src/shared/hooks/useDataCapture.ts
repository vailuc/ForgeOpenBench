import { useState, useRef, useCallback, useMemo } from "react";

export interface DataSample {
  value: number;
  unit: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface CaptureStats {
  min: number;
  max: number;
  avg: number;
  count: number;
  span: number; // max - min
  snrDb: number | null; // 20*log10(avg/span) rough proxy
}

export interface UseDataCaptureOptions {
  maxSamples?: number; // ring buffer size, default 1000
}

export function useDataCapture(opts: UseDataCaptureOptions = {}) {
  const maxSamples = opts.maxSamples ?? 1000;

  const [held, setHeld] = useState(false);
  const [heldSample, setHeldSample] = useState<DataSample | null>(null);
  const [relativeTo, setRelativeTo] = useState<number | null>(null);
  const [latest, setLatest] = useState<DataSample | null>(null);

  const samplesRef = useRef<DataSample[]>([]);

  const push = useCallback((sample: DataSample) => {
    setLatest(sample);
    const buf = samplesRef.current;
    buf.push(sample);
    if (buf.length > maxSamples) buf.shift();
  }, [maxSamples]);

  const current = useMemo((): DataSample | null => {
    if (held && heldSample) return heldSample;
    return latest;
  }, [held, heldSample, latest]);

  const stats = useMemo((): CaptureStats | null => {
    const buf = samplesRef.current;
    if (buf.length < 2) return null;
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
    return { min, max, avg, count: buf.length, span, snrDb };
  }, [latest]); // recalc whenever a new sample arrives

  const toggleHold = useCallback(() => {
    setHeld((prev) => {
      if (!prev) {
        setHeldSample(latest);
      } else {
        setHeldSample(null);
      }
      return !prev;
    });
  }, [latest]);

  const setRelative = useCallback(() => {
    const v = current?.value ?? null;
    setRelativeTo(v);
  }, [current]);

  const clearRelative = useCallback(() => {
    setRelativeTo(null);
  }, []);

  const relativeDelta = useMemo(() => {
    if (relativeTo == null || current == null) return null;
    return current.value - relativeTo;
  }, [relativeTo, current]);

  const resetStats = useCallback(() => {
    samplesRef.current = [];
  }, []);

  const saveSnapshot = useCallback(async () => {
    const sample = current;
    if (!sample) return;
    const payload = {
      plugin: "pocketforge",
      timestamp: sample.timestamp,
      value: sample.value,
      unit: sample.unit,
      meta: sample.meta,
    };
    try {
      await fetch("/api/v1/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error("[useDataCapture] save failed:", e);
      // fallback: localStorage
      const key = `fob_capture_${Date.now()}`;
      localStorage.setItem(key, JSON.stringify(payload));
    }
  }, [current]);

  return {
    current,
    held,
    stats,
    relativeTo,
    relativeDelta,
    push,
    toggleHold,
    setRelative,
    clearRelative,
    resetStats,
    saveSnapshot,
  };
}
