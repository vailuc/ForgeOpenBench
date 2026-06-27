import { useRef, useEffect, useCallback, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { UsbTransport } from "./UsbTransport";
import type { UsbDataChunk } from "./usbTypes";
import { AcquireToolbar } from "./AcquireToolbar";
import { VerticalPanel } from "./VerticalPanel";
import { HorizontalPanel } from "./HorizontalPanel";
import { TriggerPanel } from "./TriggerPanel";
import { MathPanel } from "./MathPanel";
import { MeasurementBar } from "./MeasurementBar";
import type { Measurements, VerticalState, HorizontalState, TriggerState, MathState, MeasurementKey } from "./scopeTypes";
import { SAMPLE_RATES_DSO, formatSDiv, vDivToVpp, sDivToWindowMs } from "./scopeConstants";

/* ── Props ─────────────────────────────────────────────────────────── */
interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

/* ── Enhanced measurement helpers ──────────────────────────────────── */
function calcMeasurements(buf: number[], rate: number): Measurements {
  if (buf.length < 2) {
    return {
      vpp: 0, dc: 0, vrms: 0, freq: 0, period: 0,
      riseTime: 0, fallTime: 0, dutyCycle: 0,
      positiveWidth: 0, negativeWidth: 0,
    };
  }

  let min = buf[0], max = buf[0], sum = 0, sumSq = 0;
  for (const v of buf) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const dc = sum / buf.length;
  const vpp = max - min;

  // Zero-crossing frequency
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i-1] <= dc && buf[i] > dc) || (buf[i-1] >= dc && buf[i] < dc)) crossings++;
  }
  const period = crossings > 0 ? (buf.length / rate) / (crossings / 2) : 0;
  const freq = period > 0 ? 1 / period : 0;

  // Duty cycle + pulse widths using 50% threshold
  const threshold = (min + max) / 2;
  let posTime = 0, negTime = 0;
  for (let i = 1; i < buf.length; i++) {
    const dt = 1 / rate;
    if (buf[i] > threshold) posTime += dt;
    else negTime += dt;
  }
  const totalTime = posTime + negTime;
  const dutyCycle = totalTime > 0 ? (posTime / totalTime) * 100 : 0;
  const positiveWidth = freq > 0 ? dutyCycle / 100 * period : 0;
  const negativeWidth = freq > 0 ? (1 - dutyCycle / 100) * period : 0;

  // Rise/fall time: 10% → 90% and 90% → 10% of first crossing
  const low = min + vpp * 0.1;
  const high = min + vpp * 0.9;
  let riseTime = 0, fallTime = 0;
  let inRise = false, inFall = false;
  let riseStart = 0, fallStart = 0;

  for (let i = 0; i < buf.length; i++) {
    if (!inRise && buf[i] <= low && i + 1 < buf.length && buf[i + 1] > low) {
      inRise = true; riseStart = i;
    }
    if (inRise && buf[i] >= high) {
      riseTime = (i - riseStart) / rate;
      inRise = false;
    }
    if (!inFall && buf[i] >= high && i + 1 < buf.length && buf[i + 1] < high) {
      inFall = true; fallStart = i;
    }
    if (inFall && buf[i] <= low) {
      fallTime = (i - fallStart) / rate;
      inFall = false;
    }
  }

  return {
    vpp, dc, vrms: Math.sqrt(sumSq / buf.length),
    freq, period, riseTime, fallTime, dutyCycle,
    positiveWidth, negativeWidth,
  };
}

/* ── Autoset: compute ideal V/div, s/div, trigger level ───────────── */
function autoset(ch1Buf: number[], ch2Buf: number[], rate: number, vDivSteps: number[], sDivSteps: number[]) {
  const buf = ch1Buf.length > 10 ? ch1Buf : ch2Buf;
  if (buf.length < 10) return null;

  const vpp = Math.max(...buf) - Math.min(...buf);
  const targetVDiv = vpp / 5; // ~5 divisions of signal
  const vDiv = vDivSteps.find(v => v >= targetVDiv) ?? vDivSteps[vDivSteps.length - 1];

  const m = calcMeasurements(buf, rate);
  const period = m.period || 0.001;
  const targetSDiv = period / 3; // ~3 periods across screen
  const sDiv = sDivSteps.find(s => s >= targetSDiv) ?? sDivSteps[sDivSteps.length - 1];

  const triggerLevel = (Math.max(...buf) + Math.min(...buf)) / 2;

  return { vDiv, sDiv, triggerLevel };
}

/* ── Main Component ────────────────────────────────────────────────── */
export function WaveformDsoView({ transport, isActive, connected }: Props) {
  const plotDivRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // Acquire state machine lite
  type AcquireMode = "stopped" | "running" | "single-armed" | "single-held" | "rolling" | "averaging";
  const [acquireMode, setAcquireMode] = useState<AcquireMode>("stopped");
  const acquireModeRef = useRef<AcquireMode>("stopped");
  useEffect(() => { acquireModeRef.current = acquireMode; }, [acquireMode]);

  // Data refs
  const dataOffRef = useRef<(() => void) | null>(null);
  const ch1Buf = useRef<number[]>([]);
  const ch2Buf = useRef<number[]>([]);
  const mathBuf = useRef<number[]>([]);
  const filtRing1 = useRef<number[]>([]);
  const filtRing2 = useRef<number[]>([]);
  const intentionalStopRef = useRef(false);
  const startRef = useRef<() => Promise<void>>(async () => {});
  const connectedRef = useRef(connected);
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  // Average mode accumulation
  const avgAccumCount = useRef(0);
  const avgBuf1 = useRef<number[]>([]);
  const avgBuf2 = useRef<number[]>([]);

  // Compatibility shims — old boolean refs mapped to new acquireMode
  // TODO: migrate all references to acquireModeRef directly
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const singleArmedRef = useRef(false);
  const singleJustTriggeredRef = useRef(false);
  useEffect(() => {
    const mode = acquireModeRef.current;
    runningRef.current = mode !== "stopped" && mode !== "single-held";
    pausedRef.current = false;
    singleArmedRef.current = mode === "single-armed";
    singleJustTriggeredRef.current = false;
  });

  // Vertical state (new hardware layout)
  const [ch1Vertical, setCh1Vertical] = useState<VerticalState>({
    enabled: true, vDiv: 0.5, position: 0, coupling: "dc",
    probe: 1, invert: false, bwLimit: false,
  });
  const [ch2Vertical, setCh2Vertical] = useState<VerticalState>({
    enabled: true, vDiv: 0.5, position: 0, coupling: "dc",
    probe: 1, invert: false, bwLimit: false,
  });

  // Horizontal state
  const [horizontal, setHorizontal] = useState<HorizontalState>({
    sDiv: 0.002, position: 0, acquireMode: "normal",
    averageCount: 16, rollMode: false,
  });

  // Sync horizontal panel acquire mode to global acquireMode
  useEffect(() => {
    const mode = acquireModeRef.current;
    if (mode === "stopped" || mode === "single-held") return; // don't auto-start
    if (horizontal.rollMode) {
      if (mode !== "rolling") setAcquireMode("rolling");
    } else if (horizontal.acquireMode === "average") {
      if (mode !== "averaging") setAcquireMode("averaging");
    } else {
      if (mode !== "running") setAcquireMode("running");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizontal.acquireMode, horizontal.rollMode]);

  // Trigger state
  const [trigger, setTrigger] = useState<TriggerState>({
    source: "ch1", level: 0, slope: "rise",
    mode: "auto", coupling: "dc", holdoff: 0,
  });

  // Math state
  const [math, setMath] = useState<MathState>({
    enabled: false, sourceA: "ch1", sourceB: "ch2", op: "add",
  });

  // Sample rate (shared)
  const [sampleRate, setSampleRate] = useState(4_000_000);

  // Measurements
  const [ch1Meas, setCh1Meas] = useState<Measurements>({
    vpp: 0, dc: 0, vrms: 0, freq: 0, period: 0,
    riseTime: 0, fallTime: 0, dutyCycle: 0,
    positiveWidth: 0, negativeWidth: 0,
  });
  const [ch2Meas, setCh2Meas] = useState<Measurements>({
    vpp: 0, dc: 0, vrms: 0, freq: 0, period: 0,
    riseTime: 0, fallTime: 0, dutyCycle: 0,
    positiveWidth: 0, negativeWidth: 0,
  });

  // Selected measurement keys to display
  const [ch1MeasKeys] = useState<MeasurementKey[]>(["vpp", "freq", "vrms"]);
  const [ch2MeasKeys] = useState<MeasurementKey[]>(["vpp", "freq", "vrms"]);

  const measThrottleRef = useRef(0);
  const plotThrottleRef = useRef(0);

  // Derived values for backend
  const vpp = vDivToVpp(ch1Vertical.vDiv);
  const windowMs = sDivToWindowMs(horizontal.sDiv);

  // Refs for async handlers
  const ch1VerticalRef = useRef(ch1Vertical);
  const ch2VerticalRef = useRef(ch2Vertical);
  const horizontalRef = useRef(horizontal);
  const triggerRef = useRef(trigger);
  const sampleRateRef = useRef(sampleRate);
  useEffect(() => { ch1VerticalRef.current = ch1Vertical; }, [ch1Vertical]);
  useEffect(() => { ch2VerticalRef.current = ch2Vertical; }, [ch2Vertical]);
  useEffect(() => { horizontalRef.current = horizontal; }, [horizontal]);
  useEffect(() => { triggerRef.current = trigger; }, [trigger]);
  useEffect(() => { sampleRateRef.current = sampleRate; }, [sampleRate]);
  const mathRef = useRef(math);
  useEffect(() => { mathRef.current = math; }, [math]);

  // Auto-start when connected
  useEffect(() => {
    if (connected && !runningRef.current && !pausedRef.current) {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Build / rebuild uPlot
  const buildPlot = useCallback((container: HTMLDivElement) => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null; }
    const W = container.offsetWidth || 600;
    const H = container.offsetHeight || 300;

    const timeAxisValues = (_u: uPlot, splits: number[]): string[] => {
      const maxVal = Math.max(...splits.map(Math.abs));
      if (maxVal < 1e-6) return splits.map(v => `${(v * 1e9).toFixed(0)}ns`);
      if (maxVal < 1e-3) return splits.map(v => `${(v * 1e6).toFixed(1)}µs`);
      if (maxVal < 1)    return splits.map(v => `${(v * 1e3).toFixed(0)}ms`);
      return splits.map(v => `${v.toFixed(2)}s`);
    };

    const useMV = vpp < 2;
    const voltAxisValues = (_u: uPlot, splits: number[]): string[] => {
      if (useMV) return splits.map(v => `${(v * 1e3).toFixed(0)}mV`);
      return splits.map(v => `${v.toFixed(2)}V`);
    };

    // Draw trigger level line
    const drawTriggerLine = (u: uPlot) => {
      const level = triggerRef.current.level;
      const ctx = u.ctx;
      const plotTop = u.bbox.top;
      const plotH = u.bbox.height;
      const plotLeft = u.bbox.left;
      const plotRight = plotLeft + u.bbox.width;
      const vmin = -vpp / 2;
      const vmax = vpp / 2;
      const yScale = plotH / (vmax - vmin);
      const yOfs = plotTop + plotH;
      const y = yOfs - (level - vmin) * yScale;

      ctx.save();
      ctx.strokeStyle = "#FF00FF";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Trigger level label
      ctx.fillStyle = "#FF00FF";
      ctx.font = "10px monospace";
      ctx.fillText(`${level.toFixed(2)}V`, plotRight - 45, y - 4);
      ctx.restore();
    };

    const opts: uPlot.Options = {
      width: W, height: H,
      padding: [0, 0, 0, 0],
      scales: { x: { time: false }, y: { range: [-vpp / 2, vpp / 2] } },
      axes: [
        { stroke: "#666688", grid: { stroke: "#1A1A2E" }, values: timeAxisValues },
        { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: useMV ? "mV" : "V", values: voltAxisValues },
      ],
      series: [
        {},
        { stroke: "#F59E0B", width: 1.5, label: "CH1" },
        { stroke: "#60A5FA", width: 1.5, label: "CH2", show: ch2Vertical.enabled },
        { stroke: "#4ADE80", width: 1.5, label: "MATH", show: math.enabled },
      ],
      cursor: { show: true },
      hooks: { drawClear: [drawTriggerLine] },
    };
    plotRef.current = new uPlot(opts, [[], [], [], []], container);
  }, [vpp, ch2Vertical.enabled, math.enabled]);

  useEffect(() => {
    const div = plotDivRef.current;
    if (!div) return;
    buildPlot(div);
    const ro = new ResizeObserver(() => {
      plotRef.current?.setSize({ width: div.offsetWidth, height: div.offsetHeight });
    });
    ro.observe(div);
    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null; };
  }, [buildPlot]);

  // Data push handler
  const pushData = useCallback((chunk: UsbDataChunk) => {
    const bytes = chunk.data ?? Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
    const gain = vpp / 256;

    for (let i = 0; i + 1 < bytes.length; i += 2) {
      let v1 = (bytes[i]   - 128) * gain + ch1VerticalRef.current.position / 1000;
      let v2 = (bytes[i+1] - 128) * gain + ch2VerticalRef.current.position / 1000;

      if (ch1VerticalRef.current.invert) v1 = -v1;
      if (ch2VerticalRef.current.invert) v2 = -v2;

      ch1Buf.current.push(v1);
      ch2Buf.current.push(v2);
    }

    // Window trim
    const dt = 1 / chunk.rate;
    const MAX_SAMPLES = 200_000;
    const maxSamples = Math.min(Math.ceil(windowMs / 1000 / dt), MAX_SAMPLES);
    if (ch1Buf.current.length > maxSamples) {
      ch1Buf.current = ch1Buf.current.slice(-maxSamples);
      ch2Buf.current = ch2Buf.current.slice(-maxSamples);
    }

    // Measurements (throttled ~5Hz)
    const m1 = calcMeasurements(ch1Buf.current, chunk.rate);
    const m2 = calcMeasurements(ch2Buf.current, chunk.rate);
    const now = Date.now();
    if (now - measThrottleRef.current > 200) {
      measThrottleRef.current = now;
      setCh1Meas(m1);
      setCh2Meas(m2);
    }

    // ── Mode-aware render decision ────────────────────────────────────
    const mode = acquireModeRef.current;
    const nowPerf = performance.now();
    if (mode === "stopped" || mode === "single-held") return;

    // Trigger detection helper
    const detectTrigger = (buf: number[]): boolean => {
      if (buf.length < 100) return false;
      const level = triggerRef.current.level;
      const slope = triggerRef.current.slope;
      const checkStart = Math.max(0, buf.length - 500);
      for (let i = checkStart + 1; i < buf.length; i++) {
        const prev = buf[i - 1], curr = buf[i];
        if (slope === "rise" && prev <= level && curr > level) return true;
        if (slope === "fall" && prev >= level && curr < level) return true;
        if (slope === "both" && ((prev <= level && curr > level) || (prev >= level && curr < level))) return true;
      }
      return false;
    };

    // Render helper — always pass 4 arrays matching uPlot series count
    const renderNow = (ch1: number[], ch2: number[]) => {
      plotThrottleRef.current = nowPerf;
      const n = ch1.length;
      const width = plotRef.current?.width ?? 1000;
      const target = Math.max(1000, width * 2);
      const doMath = mathRef.current.enabled && mathRef.current.op !== "fft" && mathRef.current.op !== "xy";
      if (doMath) {
        const a = mathRef.current.sourceA === "ch2" ? ch2 : ch1;
        const b = mathRef.current.sourceB === "ch2" ? ch2 : ch1;
        mathBuf.current = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
          const av = a[i] ?? 0, bv = b[i] ?? 0;
          const op = mathRef.current.op;
          if (op === "add") mathBuf.current[i] = av + bv;
          else if (op === "sub") mathBuf.current[i] = av - bv;
          else if (op === "mul") mathBuf.current[i] = av * bv;
          else if (op === "div") mathBuf.current[i] = bv !== 0 ? av / bv : 0;
        }
      }
      const mathArr = doMath ? mathBuf.current : new Array(n).fill(0);
      if (n <= target) {
        const xs = Float64Array.from({ length: n }, (_, i) => i * dt);
        plotRef.current?.setData([xs, new Float64Array(ch1), new Float64Array(ch2), new Float64Array(mathArr)]);
      } else {
        const step = Math.floor(n / target);
        const m = Math.ceil(n / step);
        const xs = new Float64Array(m), ys1 = new Float64Array(m), ys2 = new Float64Array(m), ysM = new Float64Array(m);
        for (let i = 0, j = 0; i < n; i += step, j++) { xs[j] = i * dt; ys1[j] = ch1[i]; ys2[j] = ch2[i]; ysM[j] = mathArr[i]; }
        plotRef.current?.setData([xs, ys1, ys2, ysM]);
      }
    };

    const sourceBuf = triggerRef.current.source === "ch2" ? ch2Buf.current : ch1Buf.current;

    if (mode === "single-armed") {
      if (detectTrigger(sourceBuf)) {
        setAcquireMode("single-held");
        renderNow(ch1Buf.current, ch2Buf.current);
        void stop(true);
      }
      return;
    }

    if (mode === "averaging") {
      if (detectTrigger(sourceBuf)) {
        const n = ch1Buf.current.length;
        if (avgAccumCount.current === 0) {
          avgBuf1.current = new Array(n).fill(0);
          avgBuf2.current = new Array(n).fill(0);
        }
        for (let i = 0; i < n; i++) {
          avgBuf1.current[i] += ch1Buf.current[i];
          avgBuf2.current[i] += ch2Buf.current[i];
        }
        avgAccumCount.current++;
        const targetCount = horizontalRef.current.averageCount;
        if (avgAccumCount.current >= targetCount) {
          const divisor = avgAccumCount.current;
          const avg1 = avgBuf1.current.map(v => v / divisor);
          const avg2 = avgBuf2.current.map(v => v / divisor);
          renderNow(avg1, avg2);
          avgAccumCount.current = 0;
          avgBuf1.current = [];
          avgBuf2.current = [];
        }
      }
      return;
    }

    if (mode === "rolling") {
      // Bypass trigger, render latest window continuously
      if (nowPerf - plotThrottleRef.current > 50) {
        renderNow(ch1Buf.current, ch2Buf.current);
      }
      return;
    }

    // mode === "running"
    if (nowPerf - plotThrottleRef.current > 50) {
      if (triggerRef.current.mode === "auto" || detectTrigger(sourceBuf)) {
        renderNow(ch1Buf.current, ch2Buf.current);
      }
    }
  }, [vpp, windowMs]);

  // Start / stop
  const start = useCallback(async () => {
    if (!connected || runningRef.current) return;
    ch1Buf.current = [];
    ch2Buf.current = [];
    mathBuf.current = [];
    filtRing1.current = [];
    filtRing2.current = [];
    plotThrottleRef.current = 0;
    try {
      await transport.configure({
        mode: "dso",
        sample_rate_hz: sampleRateRef.current,
        sample_width: 8,
        voltage_range: vpp,
      });
      dataOffRef.current?.();
      dataOffRef.current = transport.onData(pushData);
      await transport.start();
      runningRef.current = true;
      setAcquireMode("running");
    } catch (e) {
      runningRef.current = false;
      setAcquireMode("stopped");
      console.warn("[DSO] start error", e);
    }
  }, [connected, transport, pushData, vpp]);

  const stop = useCallback(async (intentional = false) => {
    intentionalStopRef.current = intentional;
    runningRef.current = false;
    setAcquireMode("stopped");
    dataOffRef.current?.();
    dataOffRef.current = null;
    ch1Buf.current = [];
    ch2Buf.current = [];
    mathBuf.current = [];
    filtRing1.current = [];
    filtRing2.current = [];
    try { await transport.stop(); } catch { }
  }, [transport]);

  useEffect(() => { startRef.current = start; }, [start]);

  // Auto-restart on backend drop
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = transport.onStopped(() => {
      if (!runningRef.current) return;
      runningRef.current = false;
      setAcquireMode("stopped");
      ch1Buf.current = []; ch2Buf.current = []; mathBuf.current = [];
      filtRing1.current = []; filtRing2.current = [];
      if (intentionalStopRef.current) {
        intentionalStopRef.current = false;
        return;
      }
      if (connectedRef.current && !pausedRef.current) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (connectedRef.current && !runningRef.current && !pausedRef.current) {
            void startRef.current();
          }
        }, 1000);
      }
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [transport]);

  // Cleanup on deactivate
  useEffect(() => {
    if (!isActive || !connected) {
      if (runningRef.current) void stop(true);
      else { dataOffRef.current?.(); dataOffRef.current = null; }
    }
  }, [isActive, connected, stop]);

  // Toolbar handlers
  const handleRun = () => { void start(); };
  const handleStop = () => void stop(true);
  const handleSingle = () => {
    setAcquireMode("single-armed");
    void start();
  };
  const handleAutoSet = () => {
    const result = autoset(ch1Buf.current, ch2Buf.current, sampleRate, [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10], [1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 1e-1, 2e-1, 5e-1, 1, 2, 5]);
    if (result) {
      setCh1Vertical(prev => ({ ...prev, vDiv: result.vDiv }));
      setCh2Vertical(prev => ({ ...prev, vDiv: result.vDiv }));
      setHorizontal(prev => ({ ...prev, sDiv: result.sDiv }));
      setTrigger(prev => ({ ...prev, level: result.triggerLevel }));
    }
  };
  const handleForceTrigger = () => {
    // In software trigger mode, just re-render current buffer aligned to trigger
    // TODO: Phase 2
  };
  const handleSetTrigger50Percent = () => {
    const buf = ch1Buf.current.length > 10 ? ch1Buf.current : ch2Buf.current;
    if (buf.length < 10) return;
    const mid = (Math.max(...buf) + Math.min(...buf)) / 2;
    setTrigger(prev => ({ ...prev, level: mid }));
  };
  const handleClear = () => {
    ch1Buf.current = []; ch2Buf.current = []; mathBuf.current = [];
    plotRef.current?.setData([[], [], [], []]);
    setCh1Meas({ vpp: 0, dc: 0, vrms: 0, freq: 0, period: 0, riseTime: 0, fallTime: 0, dutyCycle: 0, positiveWidth: 0, negativeWidth: 0 });
    setCh2Meas({ vpp: 0, dc: 0, vrms: 0, freq: 0, period: 0, riseTime: 0, fallTime: 0, dutyCycle: 0, positiveWidth: 0, negativeWidth: 0 });
  };

  const rateLabel = SAMPLE_RATES_DSO.find(r => r.hz === sampleRate)?.label ?? `${sampleRate / 1e6}MS/s`;

  return (
    <div className="flex flex-col h-full bg-fob-surface text-fob-text font-mono text-xs select-none">
      {/* Acquire Toolbar */}
      <AcquireToolbar
        running={acquireMode === "running" || acquireMode === "single-armed"}
        paused={acquireMode === "single-held"}
        onRun={handleRun}
        onStop={handleStop}
        onSingle={handleSingle}
        onAutoSet={handleAutoSet}
        onForceTrigger={handleForceTrigger}
        onClear={handleClear}
        sampleRateLabel={rateLabel}
        sDivLabel={formatSDiv(horizontal.sDiv)}
        connected={connected}
      />

      {/* Main Area: Canvas + Right Panel */}
      <div className="flex flex-1 gap-1 overflow-hidden min-h-0">
        {/* Canvas */}
        <div ref={plotDivRef} className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0" />

        {/* Right Control Panel */}
        <div className="w-72 flex flex-col gap-2 shrink-0 overflow-y-auto text-[11px] px-1 py-1">
          <VerticalPanel
            ch1={ch1Vertical}
            ch2={ch2Vertical}
            onCh1Change={setCh1Vertical}
            onCh2Change={setCh2Vertical}
            disabled={false}
          />
          <HorizontalPanel
            state={horizontal}
            onChange={setHorizontal}
            sampleRate={sampleRate}
            onSampleRateChange={setSampleRate}
            disabled={false}
          />
          <TriggerPanel
            state={trigger}
            onChange={setTrigger}
            onSet50Percent={handleSetTrigger50Percent}
            disabled={false}
          />
          <MathPanel
            state={math}
            onChange={setMath}
            disabled={false}
          />
        </div>
      </div>

      {/* Measurement Bar */}
      <MeasurementBar
        ch1={ch1Meas}
        ch2={ch2Meas}
        ch1Keys={ch1MeasKeys}
        ch2Keys={ch2MeasKeys}
      />
    </div>
  );
}
