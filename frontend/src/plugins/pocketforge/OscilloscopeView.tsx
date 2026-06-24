import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import uPlot from "uplot";
import { BleTransport } from "./BleTransport";
import { BridgeTransport } from "./BridgeTransport";
import { DsoService, DsoCaptureBuffer } from "./DsoService";
import { StatusService } from "./StatusService";
import {
  MeterMode, DsoCommand, DsoStatus, formatSi, unitForMode, dsoRangesForMode, modeLabel,
  getSwitchPosition, type DsoMetadata,
} from "./types";
import { StatusServiceUuids } from "./uuids";
import { Waveform } from "./Waveform";
import { computeMetrics } from "./waveformMetrics";
import { toast } from "../../shared/hooks/useToastStore";
import type { PluginBus } from "../types";
import { useSettingsStore } from "../../core/settings_store";
import {
  getSharedTransport,
  getSharedMetaUnsub, setSharedMetaUnsub,
  getSharedSampleUnsub, setSharedSampleUnsub,
  getSharedMeterBusy,
} from "./sharedTransport";
import { globalBus } from "../../core/global_bus";

type Transport = BleTransport | BridgeTransport;
type ConnectionState = "disconnected" | "connecting" | "reconnecting" | "connected";

const CHUNK_SIZE = 2000;
const MIN_RESTART_DELAY_MS = 200;
const CONTINUOUS_RATE = 25600;

const DSO_MODES = [
  { value: MeterMode.DcVoltage, label: "DC Voltage" },
  { value: MeterMode.AcVoltage, label: "AC Voltage" },
  { value: MeterMode.DcCurrent, label: "DC Current" },
  { value: MeterMode.AcCurrent, label: "AC Current" },
];

const WINDOW_PRESETS = [
  { value: 2, label: "2 ms" },
  { value: 5, label: "5 ms" },
  { value: 10, label: "10 ms" },
  { value: 20, label: "20 ms" },
  { value: 50, label: "50 ms" },
  { value: 100, label: "100 ms" },
  { value: 200, label: "200 ms" },
];

const DSO_SETTINGS_KEY = "fob_dso_settings";

function loadDsoSettings() {
  try {
    const raw = localStorage.getItem(DSO_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

export function OscilloscopeView({ isActive }: { bus?: PluginBus; isActive?: boolean }) {
  const saved = loadDsoSettings();
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [_deviceName, setDeviceName] = useState("");
  const [mode, setMode] = useState<MeterMode>(saved?.mode ?? MeterMode.DcVoltage);
  const [range, setRange] = useState<number>(saved?.range ?? 5);
  const [triggerLevel, setTriggerLevel] = useState<number>(saved?.triggerLevel ?? 0);
  const [command, setCommand] = useState<DsoCommand>(saved?.command ?? DsoCommand.FreeRunning);
  const [windowMs, setWindowMs] = useState<number>(saved?.windowMs ?? 10);
  const [numSamples, setNumSamples] = useState<number>(saved?.numSamples ?? 1024);
  const [continuous, setContinuous] = useState(saved?.continuous ?? false);
  const [continuousDelayMs, _setContinuousDelayMs] = useState<number>(saved?.continuousDelayMs ?? 500);
  const [capturesVisible, _setCapturesVisible] = useState(saved?.capturesVisible ?? 10);
  const [displayMode, setDisplayMode] = useState<"roll" | "sweep">(saved?.displayMode ?? "roll");
  const [crawlDurationMs, setCrawlDurationMs] = useState(saved?.crawlDurationMs ?? 0);
  const [sweepSubMode, setSweepSubMode] = useState<"free" | "triggered">(saved?.sweepSubMode ?? "free");

  // Persist settings to localStorage (debounced 500ms to avoid thrashing during slider drag)
  const saveSettingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveSettingsTimerRef.current) clearTimeout(saveSettingsTimerRef.current);
    saveSettingsTimerRef.current = setTimeout(() => {
      const settings = { mode, range, triggerLevel, command, windowMs, numSamples, continuous, continuousDelayMs, capturesVisible, displayMode, crawlDurationMs, sweepSubMode };
      localStorage.setItem(DSO_SETTINGS_KEY, JSON.stringify(settings));
    }, 500);
    return () => { if (saveSettingsTimerRef.current) clearTimeout(saveSettingsTimerRef.current); };
  }, [mode, range, triggerLevel, command, windowMs, numSamples, continuous, continuousDelayMs, capturesVisible, displayMode, crawlDurationMs, sweepSubMode]);

  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { displayModeRef.current = displayMode; }, [displayMode]);
  useEffect(() => { windowMsRef.current = windowMs; }, [windowMs]);

  const [meta, setMeta] = useState<DsoMetadata | null>(null);
  const [values, setValues] = useState<number[]>([]);

  const transportRef = useRef<Transport | null>(getSharedTransport() as Transport | null);
  const bufferRef = useRef<DsoCaptureBuffer | null>(null);
  const pendingRestartRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureGenRef = useRef(0);
  const startGenRef = useRef(0);
  const samplesReceivedRef = useRef(0);
  const effectiveNumSamplesRef = useRef(numSamples);
  const isStartingRef = useRef(false);
  const hiddenContinuousRef = useRef(false);
  const targetSamplesRef = useRef(0);
  const metaUnsubRef = useRef<(() => Promise<void>) | null>(getSharedMetaUnsub());
  const sampleUnsubRef = useRef<(() => Promise<void>) | null>(getSharedSampleUnsub());

  const plotRef = useRef<uPlot | null>(null);
  const plotDirtyRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const sampleRateRef = useRef(CONTINUOUS_RATE);
  const displayModeRef = useRef<"roll" | "sweep">(displayMode);
  const windowMsRef = useRef(windowMs);
  const handleSaveRef = useRef<() => void>(() => {});

  // Jitter buffer: smooth time-based playback decoupled from BLE chunk arrival
  const JITTER_CAP = 100000; // ~4s at 25.6kHz
  const jitterBufRef = useRef<Float64Array | null>(null);
  const jitterHeadRef = useRef(0);
  const jitterTotalRef = useRef(0);
  const playbackLatencyMsRef = useRef(300); // bullet-time runway: 300ms default
  const readHeadRef = useRef(0);            // persistent playback cursor (samples)
  const lastFrameTimeRef = useRef(0);     // for frame-delta adaptive speed
  const lastSweepIndexRef = useRef(0);
  const sweepHistoryRef = useRef<{ trace: Float64Array; dt: number }[]>([]);
  const valuesRef = useRef<number[]>([]);
  useEffect(() => { valuesRef.current = values; }, [values]);
  const crawlStartRef = useRef(0);
  const crawlRafRef = useRef<number | null>(null);
  const pendingScaleRef = useRef(1); // scale from metadata arrives before bufferRef is created in one-shot
  const rangeMismatchWarnedRef = useRef(false);

  const [relActive, setRelActive] = useState(false);
  const relRef = useRef<number | null>(null);
  const [gateActive, setGateActive] = useState(false);
  const [snrActive, setSnrActive] = useState(false);
  const [snrSigma, setSnrSigma] = useState(2);
  const [calibratedNoise, setCalibratedNoise] = useState<{ mean: number; stdDev: number; peakToPeak: number } | null>(null);

  const connected = connectionState === "connected";

  useEffect(() => {
    useSettingsStore.getState().setPluginConnected("pocketforge", connected);
  }, [connected]);

  // On mount / visibility change: sync shared transport so DSO knows about
  // connections made in other tabs (e.g. Meter connected first).
  // Event-driven: listen for pocketforge.meter.released instead of polling.
  // Shows a toast while waiting so the user knows why DSO hasn't started yet.
  useEffect(() => {
    if (!isActive) {
      void stopCapture();
      return;
    }

    const syncTransport = () => {
      const t = getSharedTransport();
      if (t && t.isConnected) {
        transportRef.current = t as Transport;
        setConnectionState("connected");
        setDeviceName(t.deviceName);
      }
    };

    // If meter is already idle, proceed immediately (no toast needed)
    if (!getSharedMeterBusy() && !getSharedMetaUnsub() && !getSharedSampleUnsub()) {
      syncTransport();
      return;
    }

    // Meter is still releasing — show toast and wait for event
    let cancelled = false;
    const toastId = toast.info("Waiting for meter to release GATT…");
    const deadlineTimer = setTimeout(() => {
      if (cancelled) return;
      toast.dismiss(toastId);
      toast.warning("GATT release timed out — DSO may not start");
      syncTransport();
    }, 2000);

    const unsub = globalBus.on("pocketforge.meter.released", () => {
      if (cancelled) return;
      clearTimeout(deadlineTimer);
      toast.dismiss(toastId);
      syncTransport();
    });

    return () => {
      cancelled = true;
      clearTimeout(deadlineTimer);
      unsub();
      toast.dismiss(toastId);
    };
  }, [isActive]);

  // rAF loop: adaptive-speed playback cursor for smooth 60 fps regardless of chunk jitter
  // Only active while running to avoid idle CPU waste
  useEffect(() => {
    if (!runningRef.current) return;
    const loop = () => {
      if (!runningRef.current) return;
      const hasPlot = !!plotRef.current;
      const hasJitter = !!jitterBufRef.current;
      const jitterTotal = jitterTotalRef.current;
      if (!hasPlot || !hasJitter || jitterTotal === 0) {
        rafIdRef.current = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      const sr = sampleRateRef.current;
      const cap = effectiveNumSamplesRef.current;
      const dt = 1000 / sr;
      const mode = displayModeRef.current;
      const buf = jitterBufRef.current!;
      const scale = bufferRef.current?.scale ?? 1;

      // Initialize cursor on first frame after start
      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = now;
        readHeadRef.current = 0;
      }
      const frameDt = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      // Adaptive playback speed based on buffer runway
      const targetLatency = Math.max(50, playbackLatencyMsRef.current);
      const targetLatencySamples = Math.round(targetLatency * sr / 1000);
      const bufferAhead = jitterTotal - readHeadRef.current;
      let speed = 1.0;
      if (bufferAhead > targetLatencySamples * 3) {
        speed = 1.8; // way behind live, catch up fast
      } else if (bufferAhead > targetLatencySamples * 1.5) {
        speed = 1.15; // slightly ahead of target
      } else if (bufferAhead < targetLatencySamples * 0.3) {
        speed = 0.3; // nearly empty, slow crawl
      } else if (bufferAhead < targetLatencySamples * 0.7) {
        speed = 0.7; // low, ease up
      }

      // Advance persistent cursor
      readHeadRef.current += (frameDt * sr / 1000) * speed;
      readHeadRef.current = Math.min(readHeadRef.current, jitterTotal - 1);
      readHeadRef.current = Math.max(readHeadRef.current, 0);

      const readHead = Math.floor(readHeadRef.current);

      if (mode === "roll") {
        // Show the last `cap` samples ending at readHead
        const start = Math.max(0, readHead - cap);
        const end = readHead;
        const count = end - start;
        if (count > 0) {
          const xs = new Float64Array(count);
          const ys = new Float64Array(count);
          for (let i = 0; i < count; i++) {
            xs[i] = (start + i) * dt;
            ys[i] = buf[(start + i) % JITTER_CAP] * scale;
          }
          plotRef.current!.setData([xs, ys], false);
          const xMax = readHead * dt;
          const xMin = Math.max(0, xMax - windowMsRef.current);
          plotRef.current!.setScale("x", { min: xMin, max: xMax });
        }
      } else {
        // Sweep: beam advances at sample rate, wraps every `cap` samples
        const sweepIndex = Math.floor(readHead / cap);
        const sweepStart = sweepIndex * cap;
        const sweepCursor = Math.min(readHead - sweepStart, cap);
        const start = sweepStart;
        const end = Math.min(sweepStart + sweepCursor, jitterTotal);
        const count = end - start;
        if (count > 0) {
          const xs = new Float64Array(count);
          const ys = new Float64Array(count);
          for (let i = 0; i < count; i++) {
            xs[i] = i * dt;
            ys[i] = buf[(start + i) % JITTER_CAP] * scale;
          }
          plotRef.current!.setData([xs, ys], false);
        }
        plotRef.current!.setScale("x", { min: 0, max: windowMsRef.current });

        // Commit completed sweeps to history for phosphor
        if (sweepIndex > lastSweepIndexRef.current) {
          const prevStart = lastSweepIndexRef.current * cap;
          const prevEnd = Math.min(prevStart + cap, jitterTotal);
          const prevCount = prevEnd - prevStart;
          if (prevCount > 0) {
            const trace = new Float64Array(prevCount);
            for (let i = 0; i < prevCount; i++) trace[i] = buf![(prevStart + i) % JITTER_CAP] * scale;
            sweepHistoryRef.current.unshift({ trace, dt });
            if (sweepHistoryRef.current.length > 3) sweepHistoryRef.current.pop();
          }
          lastSweepIndexRef.current = sweepIndex;
        }
      }
      rafIdRef.current = requestAnimationFrame(loop);
    };
    rafIdRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      lastFrameTimeRef.current = 0;
    };
  }, [running, displayMode]);

  // 1x mode: crawling draw animation (progressive reveal at controlled speed)
  useEffect(() => {
    if (!running || continuous || crawlDurationMs === 0) {
      if (crawlRafRef.current) cancelAnimationFrame(crawlRafRef.current);
      crawlRafRef.current = null;
      return;
    }
    crawlStartRef.current = performance.now();

    const loop = () => {
      if (!plotRef.current) {
        crawlRafRef.current = requestAnimationFrame(loop);
        return;
      }
      const elapsed = performance.now() - crawlStartRef.current;
      const progress = Math.min(1, elapsed / crawlDurationMs);
      const totalSamples = valuesRef.current.length;
      const targetVisible = Math.floor(progress * effectiveNumSamplesRef.current);
      const showCount = Math.min(targetVisible, totalSamples);

      if (showCount > 0) {
        const dt = 1000 / sampleRateRef.current;
        const xs = new Float64Array(showCount);
        const ys = new Float64Array(showCount);
        for (let i = 0; i < showCount; i++) {
          xs[i] = i * dt;
          ys[i] = valuesRef.current[i];
        }
        plotRef.current.setData([xs, ys], false);
        plotRef.current.setScale("x", { min: 0, max: windowMsRef.current });
      }

      if (progress < 1 && runningRef.current) {
        crawlRafRef.current = requestAnimationFrame(loop);
      } else {
        crawlRafRef.current = null;
      }
    };

    crawlRafRef.current = requestAnimationFrame(loop);
    return () => {
      if (crawlRafRef.current) cancelAnimationFrame(crawlRafRef.current);
    };
  }, [running, continuous, crawlDurationMs]);

  const effectiveNumSamples = continuous
    ? Math.max(64, Math.round(windowMs * CONTINUOUS_RATE / 1000))
    : numSamples;

  useEffect(() => { effectiveNumSamplesRef.current = effectiveNumSamples; }, [effectiveNumSamples]);

  const sampleRate = meta?.samplingRate ?? ((effectiveNumSamples / (windowMs / 1000)) || CONTINUOUS_RATE);
  useEffect(() => { sampleRateRef.current = sampleRate; }, [sampleRate]);
  const xs = useMemo(() => values.map((_, i) => (i / sampleRate) * 1000), [values, sampleRate]);
  const metrics = useMemo(() => computeMetrics(values, sampleRate), [values, sampleRate]);

  const displaySize = running ? effectiveNumSamples * capturesVisible : 0;

  const displayValues = useMemo(() => {
    if (!running) return values;
    if (displaySize === 0) return values;
    if (continuous) return values.slice(-displaySize);
    // 1x mode: show all captured data as it arrives (delay window logic was hiding early data)
    return values;
  }, [values, running, displaySize, continuous]);

  const displayXs = useMemo(() => {
    if (displaySize === 0) return xs;
    const dt = 1000 / sampleRate;
    const totalMs = values.length * dt;
    const wMs = displaySize * dt;
    if (totalMs <= wMs) {
      return Array.from({ length: displayValues.length }, (_, i) => i * dt);
    }
    const endMs = totalMs;
    return Array.from({ length: displayValues.length }, (_, i) =>
      endMs - (displayValues.length - 1 - i) * dt
    );
  }, [displaySize, displayValues.length, sampleRate, values.length, xs]);

  const relDisplayValues = useMemo(() => {
    if (!relActive || relRef.current === null) return displayValues;
    return displayValues.map((v) => v - relRef.current!);
  }, [displayValues, relActive]);

  const gatedDisplayValues = useMemo(() => {
    if (!gateActive || !calibratedNoise || relDisplayValues.length < 2) return relDisplayValues;
    const threshold = calibratedNoise.stdDev * 2;
    if (relActive) return relDisplayValues.map((v) => (Math.abs(v) < threshold ? 0 : v));
    const mean = relDisplayValues.reduce((a, b) => a + b, 0) / relDisplayValues.length;
    return relDisplayValues.map((v) => (Math.abs(v - mean) < threshold ? mean : v));
  }, [relDisplayValues, gateActive, calibratedNoise, relActive]);

  const snrDisplayValues = useMemo(() => {
    if (!snrActive || !calibratedNoise || gatedDisplayValues.length < 2) return gatedDisplayValues;
    const threshold = calibratedNoise.stdDev * snrSigma;
    return gatedDisplayValues.map((v) => (Math.abs(v) < threshold ? 0 : v));
  }, [gatedDisplayValues, snrActive, calibratedNoise, snrSigma]);

  const isVoltage = mode === MeterMode.DcVoltage || mode === MeterMode.AcVoltage;
  const rangeTable = isVoltage ? dsoRangesForMode(MeterMode.DcVoltage) : dsoRangesForMode(MeterMode.DcCurrent);
  const rangeLimit = rangeTable.find((r) => r.value === range)?.max ?? Infinity;
  const isClipping = useMemo(() => {
    if (!values.length || !rangeLimit || rangeLimit === Infinity) return false;
    return values.some((v) => Math.abs(v) >= rangeLimit * 0.98);
  }, [values, rangeLimit]);

  const unit = unitForMode(mode);

  const stopCapture = useCallback(async () => {
    pendingRestartRef.current = false;
    hiddenContinuousRef.current = false;
    if (restartTimeoutRef.current) { clearTimeout(restartTimeoutRef.current); restartTimeoutRef.current = null; }
    // Increment gen so any notifications that slip through during async unsub are ignored
    captureGenRef.current += 1;
    await metaUnsubRef.current?.();
    await sampleUnsubRef.current?.();
    metaUnsubRef.current = null;
    sampleUnsubRef.current = null;
    setSharedMetaUnsub(null);
    setSharedSampleUnsub(null);
    // dead code removed: displayBufferRef and sweepBufferRef were never instantiated
    sweepHistoryRef.current = [];
    bufferRef.current = null;
    jitterBufRef.current = null;
    jitterHeadRef.current = 0;
    jitterTotalRef.current = 0;
    readHeadRef.current = 0;
    lastFrameTimeRef.current = 0;
    lastSweepIndexRef.current = 0;
    pendingScaleRef.current = 1;
    rangeMismatchWarnedRef.current = false;
    plotDirtyRef.current = false;
    setRunning(false);
  }, []);

  const start = useCallback(async (autoRestart = false) => {
    const t = transportRef.current;
    if (!t || !t.isConnected || isStartingRef.current) return;

    if (!autoRestart) {
      try {
        const ss = new StatusService(t, StatusServiceUuids.pokitPro);
        const s = await ss.readStatus();
        const pos = getSwitchPosition(s.status);
        if (pos === "A" || pos === "Ω") { toast.warning("Switch to V position for DSO"); return; }
      } catch { }
    }

    isStartingRef.current = true;
    if (restartTimeoutRef.current) { clearTimeout(restartTimeoutRef.current); restartTimeoutRef.current = null; }

    captureGenRef.current += 1;
    startGenRef.current = captureGenRef.current;
    samplesReceivedRef.current = 0;
    pendingRestartRef.current = false;

    if (!autoRestart) { bufferRef.current = null; setValues([]); }
    pendingScaleRef.current = 1;
    rangeMismatchWarnedRef.current = false;
    setRunning(true);

    const calculatedSamples = continuous
      ? Math.max(64, Math.round(windowMs * CONTINUOUS_RATE / 1000))
      : numSamples;

    if (!continuous && calculatedSamples > 4096) {
      hiddenContinuousRef.current = true;
      targetSamplesRef.current = calculatedSamples;
      pendingRestartRef.current = true;
    } else {
      hiddenContinuousRef.current = false;
      targetSamplesRef.current = 0;
    }

    let samplesToRequest = calculatedSamples;
    if (hiddenContinuousRef.current && bufferRef.current) {
      const remaining = targetSamplesRef.current - bufferRef.current.count;
      samplesToRequest = Math.min(CHUNK_SIZE, Math.max(remaining, 1));
    } else if (hiddenContinuousRef.current) {
      samplesToRequest = CHUNK_SIZE;
    }

    const safeWindowMs = Math.max(windowMs, Math.round(samplesToRequest / 200));

    try {
      const dso = new DsoService(t);

      // Clean up old subscriptions so we don't have duplicate handlers from restarts
      if (metaUnsubRef.current) { await metaUnsubRef.current(); metaUnsubRef.current = null; }
      if (sampleUnsubRef.current) { await sampleUnsubRef.current(); sampleUnsubRef.current = null; }

      let rafPending = false;
      // Subscribe FIRST so we don't miss notifications
      const metaUnsub = await dso.onMetadata((m) => {
        metaUnsubRef.current = metaUnsub;
        setSharedMetaUnsub(metaUnsub);
        const receiveGen = startGenRef.current;
        if (receiveGen !== captureGenRef.current) return;
        setMeta(m);
        if (m.scale && m.scale > 0) {
          pendingScaleRef.current = m.scale;
          if (bufferRef.current) {
            if (continuous) bufferRef.current.updateScale(10000, m.scale, m.samplingRate);
            else bufferRef.current.updateScale(m.numberOfSamples, m.scale, m.samplingRate);
            // Re-evaluate scaled values so one-shot displays volts even if metadata arrives after last sample
            setValues(bufferRef.current.values());
          }
        }
        if (m.range !== undefined && m.range !== range && !rangeMismatchWarnedRef.current) {
          const actual = rangeTable.find((r) => r.value === m.range)?.label ?? `range ${m.range}`;
          const wanted = rangeTable.find((r) => r.value === range)?.label ?? `range ${range}`;
          toast.warning(`Device auto-ranged to ${actual} (requested ${wanted})`);
          rangeMismatchWarnedRef.current = true;
        }
        if (m.status === DsoStatus.Done) {
          if (continuous) {
            if (!pendingRestartRef.current) {
              pendingRestartRef.current = true;
              const delay = Math.max(continuousDelayMs, MIN_RESTART_DELAY_MS);
              restartTimeoutRef.current = setTimeout(() => {
                restartTimeoutRef.current = null;
                if (runningRef.current && continuous) void start(true);
              }, delay);
            }
          } else if (hiddenContinuousRef.current && bufferRef.current && bufferRef.current.count < targetSamplesRef.current) {
            pendingRestartRef.current = false;
            const delay = Math.max(continuousDelayMs, MIN_RESTART_DELAY_MS);
            restartTimeoutRef.current = setTimeout(() => {
              restartTimeoutRef.current = null;
              if (hiddenContinuousRef.current) void start(true);
            }, delay);
          } else {
            hiddenContinuousRef.current = false;
            setRunning(false);
          }
        }
      });

      const sampleUnsub = await dso.onSamples((samples) => {
        sampleUnsubRef.current = sampleUnsub;
        setSharedSampleUnsub(sampleUnsub);
        const receiveGen = startGenRef.current;
        if (receiveGen !== captureGenRef.current) return;
        samplesReceivedRef.current += samples.length;

        if (continuous && !pendingRestartRef.current) {
          const threshold = effectiveNumSamplesRef.current * 0.9;
          if (samplesReceivedRef.current >= threshold) {
            pendingRestartRef.current = true;
            if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
            restartTimeoutRef.current = setTimeout(() => {
              restartTimeoutRef.current = null;
              if (runningRef.current && continuous) void start(true);
            }, 200);
          }
        }

        const isStreaming = continuous || hiddenContinuousRef.current;
        if (isStreaming) {
          if (!bufferRef.current) bufferRef.current = new DsoCaptureBuffer(10000, pendingScaleRef.current);
          bufferRef.current.push(samples);
          const winSamples = windowMs * 25;
          const maxDisplay = Math.max(256, winSamples * capturesVisible * 3);
          if (bufferRef.current.count > maxDisplay) bufferRef.current.trim(maxDisplay);
          setValues(bufferRef.current.values());

          // Push raw samples to jitter buffer for smooth time-based playback
          if (!jitterBufRef.current) jitterBufRef.current = new Float64Array(JITTER_CAP);
          for (let i = 0; i < samples.length; i++) {
            jitterBufRef.current[jitterHeadRef.current % JITTER_CAP] = samples[i];
            jitterHeadRef.current++;
            jitterTotalRef.current++;
          }
          plotDirtyRef.current = true;

          return;
        }

        if (!bufferRef.current) bufferRef.current = new DsoCaptureBuffer(samplesToRequest, pendingScaleRef.current);
        bufferRef.current.push(samples);

        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            if (bufferRef.current) {
              if (bufferRef.current.isStale) {
                toast.warning("Capture stalled");
                setRunning(false);
                bufferRef.current = null;
              } else {
                setValues(bufferRef.current.values());
                if (bufferRef.current.isComplete) setRunning(false);
              }
            }
            rafPending = false;
          });
        }
      });

      await dso.startDso({ command, triggerLevel, mode, range,
        samplingWindowUs: Math.round(safeWindowMs * 1000),
        numberOfSamples: samplesToRequest,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("0x80")) toast.error("Window too short");
      else toast.error(`DSO failed: ${msg}`);
      setRunning(false);
      hiddenContinuousRef.current = false;
    } finally {
      isStartingRef.current = false;
      if (!hiddenContinuousRef.current) pendingRestartRef.current = false;
    }
  }, [command, triggerLevel, mode, range, windowMs, numSamples, continuous, continuousDelayMs, capturesVisible]);

  useEffect(() => { return () => { stopCapture(); }; }, [stopCapture]);

  const drawPhosphor = useCallback((u: uPlot) => {
    const traces = sweepHistoryRef.current;
    if (!traces || traces.length === 0) return;
    u.ctx.save();
    for (let t = 0; t < traces.length; t++) {
      const { trace, dt } = traces[t];
      const alpha = 0.35 / (t + 1);
      u.ctx.globalAlpha = alpha;
      u.ctx.strokeStyle = "#00e5a0";
      u.ctx.lineWidth = 1.5;
      u.ctx.beginPath();
      for (let i = 0; i < trace.length; i++) {
        const x = u.valToPos(i * dt, "x", true);
        const y = u.valToPos(trace[i], "y", true);
        if (i === 0) u.ctx.moveTo(x, y);
        else u.ctx.lineTo(x, y);
      }
      u.ctx.stroke();
    }
    u.ctx.restore();
  }, []);

  const toggleRel = () => {
    if (relActive) { relRef.current = null; setRelActive(false); }
    else if (displayValues.length > 0) {
      relRef.current = displayValues.reduce((a, b) => a + b, 0) / displayValues.length;
      setRelActive(true);
    }
  };
  const toggleGate = () => setGateActive((g) => !g);
  const toggleSnr = () => setSnrActive((s) => !s);

  const handleCalibrate = () => {
    const source = displayValues.length > 0 ? displayValues : values;
    if (source.length < 2) return;
    const mean = source.reduce((a, b) => a + b, 0) / source.length;
    const min = Math.min(...source);
    const max = Math.max(...source);
    const variance = source.reduce((sum, v) => sum + (v - mean) ** 2, 0) / source.length;
    const result = { mean, stdDev: Math.sqrt(variance), peakToPeak: max - min };
    setCalibratedNoise(result);
    toast.success("Noise calibrated");
  };

  const isSavingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (isSavingRef.current || !values.length) return;
    isSavingRef.current = true;
    const name = `Scope ${isVoltage ? "Voltage" : "Current"} ${new Date().toLocaleTimeString()}`;
    const payload = { plugin: "pocketforge", name, timestamp: Date.now(), xs, ys: values, unit, mode: modeLabel(mode), range, sampleRate, numSamples: effectiveNumSamples };
    try {
      const resp = await fetch("/api/v1/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      toast.success(`Saved to server: ${name}`);
    } catch {
      toast.success("Saved locally");
      localStorage.setItem(`fob_dso_${Date.now()}`, JSON.stringify(payload));
    } finally {
      isSavingRef.current = false;
    }
  }, [values, xs, unit, mode, range, sampleRate, effectiveNumSamples]);

  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  const exportCsv = useCallback((): string => {
    if (!values.length) return "";
    const lines = ["time_ms,value"];
    for (let i = 0; i < values.length; i++) {
      lines.push(`${xs[i].toFixed(6)},${values[i].toExponential(6)}`);
    }
    return lines.join("\n");
  }, [values, xs]);

  const exportJson = useCallback((): string => {
    return JSON.stringify({ plugin: "pocketforge", type: "dso", name: `Scope ${isVoltage ? "Voltage" : "Current"} ${new Date().toLocaleTimeString()}`, timestamp: Date.now(), xs, ys: values, unit, mode: modeLabel(mode), range, sampleRate, numSamples: effectiveNumSamples });
  }, [values, xs, unit, mode, range, sampleRate, effectiveNumSamples]);

  const download = (data: string, filename: string, mime: string) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const rangeOptions = rangeTable.map((r) => ({ value: r.value, label: r.label }));

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex-1 min-h-0 relative">
        <Waveform
          xs={running && continuous ? [] : running && !continuous && crawlDurationMs > 0 ? [] : running ? displayXs : xs}
          ys={running && continuous ? [] : running && !continuous && crawlDurationMs > 0 ? [] : running ? snrDisplayValues : relActive || gateActive || snrActive ? snrDisplayValues : values}
          xLabel="Time (ms)"
          yLabel={relActive ? `\u0394${unit}` : unit}
          windowSize={running && continuous ? undefined : running ? displaySize : undefined}
          onPlotReady={(plot) => { plotRef.current = plot; }}
          onPlotDestroy={() => { plotRef.current = null; }}
          _mode={displayMode}
          drawHistory={displayMode === "sweep" ? drawPhosphor : undefined}
        />
        {running && values.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-fob-bg/80 text-fob-text-dim text-sm pointer-events-none">
            Acquiring data...
          </div>
        )}
      </div>

      {values.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded bg-fob-surface border border-fob-border p-2">
          <MetricPill label="Vpp" value={formatSi(metrics.peakToPeak, unit)} />
          <MetricPill label="RMS" value={formatSi(metrics.rms, unit)} />
          <MetricPill label="Mean" value={formatSi(metrics.mean, unit)} />
          <MetricPill label="Freq" value={formatSi(metrics.frequency, "Hz")} />
          <MetricPill label="Period" value={formatSi(metrics.period, "s")} />
          <MetricPill label="Duty" value={`${(metrics.dutyCycle * 100).toFixed(1)}%`} />
          {isClipping && <span className="inline-flex items-center rounded bg-fob-red/60 px-2 py-0.5 text-[10px] font-medium text-fob-red">Clipping</span>}
          {calibratedNoise && <span className="inline-flex items-center rounded bg-fob-border/40 px-2 py-0.5 text-[10px] font-medium text-fob-text-dim">Noise: {formatSi(calibratedNoise.peakToPeak, unit)} pp</span>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="flex flex-col gap-1">
          <label className="text-fob-text-dim">Mode</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text" value={mode} onChange={(e) => setMode(Number(e.target.value) as MeterMode)}>
            {DSO_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-fob-text-dim">Range</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text" value={range} onChange={(e) => setRange(Number(e.target.value))}>
            {rangeOptions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-fob-text-dim">Trigger</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text" value={command} onChange={(e) => setCommand(Number(e.target.value) as DsoCommand)}>
            <option value={DsoCommand.FreeRunning}>Free running</option>
            <option value={DsoCommand.RisingEdgeTrigger}>Rising edge</option>
            <option value={DsoCommand.FallingEdgeTrigger}>Falling edge</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-fob-text-dim">Trigger level ({unit})</label>
          <input type="number" step="0.1" value={triggerLevel} onChange={(e) => setTriggerLevel(Number(e.target.value))} className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-fob-text-dim">Window</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text" value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))}>
            {WINDOW_PRESETS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-fob-text-dim">Samples{continuous ? " (auto)" : ""}</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-text" value={numSamples} onChange={(e) => setNumSamples(Number(e.target.value))} disabled={continuous}>
            {[256, 512, 1024, 2048, 4096, 8192].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setContinuous((c: boolean) => !c)} className={`px-2 py-1 rounded text-[10px] font-bold ${continuous ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"}`}>
          {continuous ? "Continuous" : "One-shot"}
        </button>
        {!continuous && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-fob-text-dim">Draw</span>
            <input
              type="range"
              min={0}
              max={2000}
              step={100}
              value={crawlDurationMs}
              onChange={(e) => setCrawlDurationMs(Number(e.target.value))}
              className="w-20 accent-fob-orange"
            />
            <span className="text-[10px] text-fob-text-dim w-10">{crawlDurationMs === 0 ? "Fast" : `${(crawlDurationMs / 1000).toFixed(1)}s`}</span>
          </div>
        )}
        <div className="flex gap-0.5">
          <button onClick={() => setDisplayMode("roll")} className={`px-2 py-1 rounded-l text-[10px] font-bold ${displayMode === "roll" ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"}`}>Roll</button>
          <button onClick={() => setDisplayMode("sweep")} className={`px-2 py-1 rounded-r text-[10px] font-bold ${displayMode === "sweep" ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"}`}>Sweep</button>
        </div>
        {displayMode === "sweep" && (
          <div className="flex gap-0.5">
            <button onClick={() => setSweepSubMode("free")} className={`px-2 py-1 rounded-l text-[10px] font-bold ${sweepSubMode === "free" ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"}`}>Free</button>
            <button onClick={() => setSweepSubMode("triggered")} className={`px-2 py-1 rounded-r text-[10px] font-bold ${sweepSubMode === "triggered" ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"}`}>Trig</button>
          </div>
        )}
        <button onClick={toggleRel} disabled={!values.length} className={`px-2 py-1 rounded text-[10px] font-bold ${relActive ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"} disabled:opacity-40`}>
          {relActive ? "REL ON" : "REL"}
        </button>
        <button onClick={toggleGate} disabled={!calibratedNoise} className={`px-2 py-1 rounded text-[10px] font-bold ${gateActive ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"} disabled:opacity-40`}>
          {gateActive ? "GATE ON" : "GATE"}
        </button>
        <button onClick={toggleSnr} disabled={!calibratedNoise} className={`px-2 py-1 rounded text-[10px] font-bold ${snrActive ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"} disabled:opacity-40`}>
          {snrActive ? "SNR ON" : "SNR"}
        </button>
        {running ? (
          <button onClick={stopCapture} className="px-3 py-1 rounded bg-fob-red text-fob-text text-[10px] font-bold">Stop</button>
        ) : (
          <button onClick={() => start()} disabled={!connected} className="px-3 py-1 rounded bg-fob-green text-fob-text text-[10px] font-bold disabled:opacity-40">Run</button>
        )}
        <button onClick={handleSave} disabled={!values.length} className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text text-[10px] disabled:opacity-40">Save</button>
        <button onClick={() => { const csv = exportCsv(); if (!csv) { toast.warning("No data to export"); return; } download(csv, `scope_${Date.now()}.csv`, "text/csv"); toast.success("CSV downloaded"); }} disabled={!values.length} className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text text-[10px] disabled:opacity-40">CSV</button>
        <button onClick={() => { const json = exportJson(); if (!json) { toast.warning("No data to export"); return; } download(json, `scope_${Date.now()}.json`, "application/json"); toast.success("JSON downloaded"); }} disabled={!values.length} className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text text-[10px] disabled:opacity-40">JSON</button>
      </div>

      {snrActive && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-fob-text-dim">SNR σ:</span>
          <input type="range" min={1} max={5} step={0.5} value={snrSigma} onChange={(e) => setSnrSigma(Number(e.target.value))} className="flex-1 accent-fob-orange" />
          <span className="text-[10px] text-fob-text-dim w-6">{snrSigma}σ</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={handleCalibrate} disabled={!values.length} className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text text-[10px] disabled:opacity-40">Calibrate</button>
        {calibratedNoise && (
          <span className="text-[10px] text-fob-text-dim">
            {formatSi(calibratedNoise.mean, unit)} ± {formatSi(calibratedNoise.stdDev, unit)} | {formatSi(calibratedNoise.peakToPeak, unit)} pp
          </span>
        )}
      </div>

      {meta && (
        <p className="text-[10px] text-fob-text-dim">
          Rate: {formatSi(meta.samplingRate, "Hz")} · {meta.numberOfSamples} samples
          {meta.range !== range && (
            <span className="text-fob-orange ml-1">· Device range: {rangeTable.find((r) => r.value === meta.range)?.label ?? meta.range}</span>
          )}
        </p>
      )}
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-fob-bg px-2 py-0.5">
      <span className="text-[9px] uppercase tracking-wider text-fob-text-dim">{label}</span>
      <span className="ml-1 font-mono text-xs text-fob-text">{value}</span>
    </div>
  );
}
