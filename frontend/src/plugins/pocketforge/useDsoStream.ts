import { useRef, useCallback, useEffect, useState } from "react";
import { DsoService } from "./DsoService";
import { getSharedTransport } from "./sharedTransport";
import { DsoStatus } from "./types";
import type { DsoSettings } from "./DsoService";
import type { DsoMetadata } from "./types";

export interface UseDsoStreamOptions {
  enabled: boolean;
  settings: DsoSettings;
}

export interface UseDsoStreamReturn {
  running: boolean;
  ringBufRef: React.MutableRefObject<Float64Array | null>;
  ringHeadRef: React.MutableRefObject<number>;
  ringTotalRef: React.MutableRefObject<number>;
  scaleRef: React.MutableRefObject<number>;
  metadata: DsoMetadata | null;
  sampleRate: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const MIN_RESTART_DELAY_MS = 200;
const RING_CAP = 100000; // ~1s at 100kHz, ~4s at 25.6kHz

export function useDsoStream(options: UseDsoStreamOptions): UseDsoStreamReturn {
  const { enabled, settings } = options;

  const [running, setRunning] = useState(false);
  const [metadata, setMetadata] = useState<DsoMetadata | null>(null);
  const [sampleRate, setSampleRate] = useState(25600);

  const ringBufRef = useRef<Float64Array | null>(null);
  const ringHeadRef = useRef(0);
  const ringTotalRef = useRef(0);
  const scaleRef = useRef(1);
  const pendingRestartRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureGenRef = useRef(0);
  const startGenRef = useRef(0);
  const samplesReceivedRef = useRef(0);
  const metaUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const sampleUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const isStartingRef = useRef(false);
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const stopCapture = useCallback(async () => {
    pendingRestartRef.current = false;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    captureGenRef.current += 1;
    await metaUnsubRef.current?.();
    await sampleUnsubRef.current?.();
    metaUnsubRef.current = null;
    sampleUnsubRef.current = null;
    setRunning(false);
    // NOTE: we intentionally do NOT clear ringBufRef so consumer can display last capture
  }, []);

  const start = useCallback(async () => {
    const transport = getSharedTransport();
    if (!transport || !transport.isConnected || isStartingRef.current) return;

    isStartingRef.current = true;
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    captureGenRef.current += 1;
    startGenRef.current = captureGenRef.current;
    samplesReceivedRef.current = 0;
    pendingRestartRef.current = false;
    setRunning(true);
    // Reset ring buffer on fresh start so old burst data doesn't mix
    ringHeadRef.current = 0;
    ringTotalRef.current = 0;

    const dso = new DsoService(transport);

    // Clean up old subscriptions
    if (metaUnsubRef.current) { await metaUnsubRef.current(); metaUnsubRef.current = null; }
    if (sampleUnsubRef.current) { await sampleUnsubRef.current(); sampleUnsubRef.current = null; }

    try {
      const metaUnsub = await dso.onMetadata((m) => {
        const receiveGen = startGenRef.current;
        if (receiveGen !== captureGenRef.current) return;
        setMetadata(m);
        if (m.samplingRate > 0) setSampleRate(m.samplingRate);
        if (m.scale && m.scale > 0) {
          scaleRef.current = m.scale;
        }
        if (m.status === DsoStatus.Done) {
          if (!pendingRestartRef.current) {
            pendingRestartRef.current = true;
            const delay = Math.max(200, MIN_RESTART_DELAY_MS);
            restartTimeoutRef.current = setTimeout(() => {
              restartTimeoutRef.current = null;
              if (enabledRef.current) void start();
            }, delay);
          }
        }
      });
      metaUnsubRef.current = metaUnsub;

      const sampleUnsub = await dso.onSamples((samples) => {
        const receiveGen = startGenRef.current;
        if (receiveGen !== captureGenRef.current) return;
        samplesReceivedRef.current += samples.length;

        // Push to rolling ring buffer (never caps, wraps around)
        if (!ringBufRef.current) ringBufRef.current = new Float64Array(RING_CAP);
        const buf = ringBufRef.current;
        const sc = scaleRef.current;
        for (let i = 0; i < samples.length; i++) {
          buf[ringHeadRef.current % RING_CAP] = samples[i] * sc;
          ringHeadRef.current++;
          ringTotalRef.current++;
        }

        // Restart when 90% of expected samples received
        const expected = settings.numberOfSamples;
        if (!pendingRestartRef.current && samplesReceivedRef.current >= expected * 0.9) {
          pendingRestartRef.current = true;
          restartTimeoutRef.current = setTimeout(() => {
            restartTimeoutRef.current = null;
            if (enabledRef.current) void start();
          }, MIN_RESTART_DELAY_MS);
        }
      });
      sampleUnsubRef.current = sampleUnsub;

      await dso.startDso(settings);
    } catch (err) {
      console.error("[useDsoStream] start failed:", err);
      setRunning(false);
    } finally {
      isStartingRef.current = false;
    }
  }, [enabled, settings]);

  // Auto-start/stop based on enabled
  useEffect(() => {
    if (enabled) {
      void start();
    } else {
      void stopCapture();
    }
    return () => {
      void stopCapture();
    };
  }, [enabled, start, stopCapture]);

  return {
    running,
    ringBufRef,
    ringHeadRef,
    ringTotalRef,
    scaleRef,
    metadata,
    sampleRate,
    start,
    stop: stopCapture,
  };
}
