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
  const useCh1 = ch1Buf.length > 10;
  const buf = useCh1 ? ch1Buf : ch2Buf;
  if (buf.length < 10) return null;

  const vpp = Math.max(...buf) - Math.min(...buf);
  const targetVDiv = vpp / 5; // ~5 divisions of signal
  const vDiv = vDivSteps.find(v => v >= targetVDiv) ?? vDivSteps[vDivSteps.length - 1];

  const m = calcMeasurements(buf, rate);
  const period = m.period || 0.001;
  const targetSDiv = period / 3; // ~3 periods across screen
  const sDiv = sDivSteps.find(s => s >= targetSDiv) ?? sDivSteps[sDivSteps.length - 1];

  const triggerLevel = (Math.max(...buf) + Math.min(...buf)) / 2;

  return { vDiv, sDiv, triggerLevel, source: useCh1 ? "ch1" : "ch2" as "ch1" | "ch2" };
}

/* ── FFT helper (radix-2 Cooley-Tukey) ─────────────────────────────── */
function fft(buf: number[]): { real: number[]; imag: number[] } {
  const n = buf.length;
  if (n === 0) return { real: [], imag: [] };
  // Pad to next power of 2
  const N = 1 << Math.ceil(Math.log2(n));
  const real = new Array(N).fill(0);
  const imag = new Array(N).fill(0);
  for (let i = 0; i < n; i++) real[i] = buf[i];
  // Bit-reversal permutation
  for (let i = 0, j = 0; i < N; i++) {
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; }
    let k = N >> 1;
    while (k & j) { j &= ~k; k >>= 1; }
    j |= k;
  }
  // Butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const wStepReal = Math.cos(-Math.PI / half);
    const wStepImag = Math.sin(-Math.PI / half);
    for (let i = 0; i < N; i += len) {
      let wReal = 1, wImag = 0;
      for (let j = 0; j < half; j++) {
        const uReal = real[i + j];
        const uImag = imag[i + j];
        const vReal = real[i + j + half] * wReal - imag[i + j + half] * wImag;
        const vImag = real[i + j + half] * wImag + imag[i + j + half] * wReal;
        real[i + j] = uReal + vReal;
        imag[i + j] = uImag + vImag;
        real[i + j + half] = uReal - vReal;
        imag[i + j + half] = uImag - vImag;
        const nextWReal = wReal * wStepReal - wImag * wStepImag;
        wImag = wReal * wStepImag + wImag * wStepReal;
        wReal = nextWReal;
      }
    }
  }
  return { real, imag };
}

function fftMagnitude(buf: number[], sampleRate: number): { freqs: number[]; mags: number[] } {
  const { real, imag } = fft(buf);
  const N = real.length;
  const half = Math.floor(N / 2);
  const freqs: number[] = [];
  const mags: number[] = [];
  for (let i = 0; i < half; i++) {
    freqs.push(i * sampleRate / N);
    mags.push(Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / N);
  }
  return { freqs, mags };
}

// Session-persisted state — survives F5, resets on new tab / hard refresh
const SCOPE_STATE_KEY = "waveforge:scopeState";
function loadScopeState() {
  try {
    const raw = sessionStorage.getItem(SCOPE_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveScopeState(state: Record<string, unknown>) {
  try { sessionStorage.setItem(SCOPE_STATE_KEY, JSON.stringify(state)); } catch {}
}

/* ── Main Component ────────────────────────────────────────────────── */
export function WaveformDsoView({ transport, isActive, connected }: Props) {
  const plotDivRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const overviewDivRef = useRef<HTMLDivElement>(null);
  const overviewPlotRef = useRef<uPlot | null>(null);

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
  const triggerArmedRef = useRef(true); // for Normal mode: re-arm after signal leaves trigger zone
  // Smart trigger state machine
  const smartStateRef = useRef<"auto" | "locked">("auto");
  const smartTriggerCountRef = useRef(0); // consecutive triggered evaluations in auto sub-state
  const smartMissCountRef = useRef(0);    // consecutive missed triggers in locked sub-state
  useEffect(() => {
    const mode = acquireModeRef.current;
    runningRef.current = mode !== "stopped" && mode !== "single-held";
    pausedRef.current = false;
    singleArmedRef.current = mode === "single-armed";
    singleJustTriggeredRef.current = false;
  });

  // Load persisted state once on mount
  const persisted = useRef(loadScopeState()).current;

  // Vertical state (new hardware layout)
  const [ch1Vertical, setCh1Vertical] = useState<VerticalState>(
    persisted?.ch1Vertical ?? { enabled: true, vDiv: 0.5, position: 0, coupling: "dc", probe: 1, invert: false, bwLimit: false }
  );
  const [ch2Vertical, setCh2Vertical] = useState<VerticalState>(
    persisted?.ch2Vertical ?? { enabled: true, vDiv: 0.5, position: 0, coupling: "dc", probe: 1, invert: false, bwLimit: false }
  );

  // Horizontal state
  const [horizontal, setHorizontal] = useState<HorizontalState>(
    persisted?.horizontal ?? { sDiv: 0.002, position: 0, acquireMode: "normal", averageCount: 16, rollMode: false }
  );

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
  const [trigger, setTrigger] = useState<TriggerState>(
    persisted?.trigger ?? { source: "ch1", level: 0, slope: "rise", mode: "smart", coupling: "dc", holdoff: 0 }
  );

  // Math state
  const [math, setMath] = useState<MathState>(
    persisted?.math ?? { enabled: false, sourceA: "ch1", sourceB: "ch2", op: "add" }
  );

  // Digital phosphor state
  const [phosphorEnabled, setPhosphorEnabled] = useState(persisted?.phosphorEnabled ?? false);
  const phosphorEnabledRef = useRef(phosphorEnabled);
  useEffect(() => { phosphorEnabledRef.current = phosphorEnabled; }, [phosphorEnabled]);
  // Trace-echo phosphor: ring buffer of recent aligned traces
  type TraceSnapshot = { mode: "time" | "xy"; xs?: Float64Array; ys1: Float64Array; ys2: Float64Array };
  const phosphorTraces = useRef<TraceSnapshot[]>([]);
  const MAX_PHOSPHOR_TRACES = 8; // ~0.4s at 50ms throttle
  const forceTriggerRef = useRef<(() => void) | null>(null);

  // Derived view mode
  const viewMode = math.enabled && math.op === "fft" ? "fft" : math.enabled && math.op === "xy" ? "xy" : "time";

  // Sample rate (shared)
  const [sampleRate, setSampleRate] = useState(persisted?.sampleRate ?? 4_000_000);

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
  // Clear phosphor history when trigger mode changes — old ghosts don't match new mode behavior
  useEffect(() => {
    phosphorTraces.current = [];
  }, [trigger.mode]);
  const mathRef = useRef(math);
  useEffect(() => { mathRef.current = math; }, [math]);

  // Persist state on changes (survives F5, resets on new tab / hard refresh)
  useEffect(() => {
    saveScopeState({
      ch1Vertical, ch2Vertical, horizontal, trigger, math,
      phosphorEnabled, sampleRate,
    });
  }, [ch1Vertical, ch2Vertical, horizontal, trigger, math, phosphorEnabled, sampleRate]);

  // Auto-start when connected and active
  useEffect(() => {
    if (connected && isActive && !runningRef.current && !pausedRef.current) {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isActive]);

  // Build / rebuild uPlot
  const buildPlot = useCallback((container: HTMLDivElement, overviewContainer?: HTMLDivElement) => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null; }
    if (overviewPlotRef.current) { overviewPlotRef.current.destroy(); overviewPlotRef.current = null; }
    const W = container.offsetWidth || 600;
    const H = container.offsetHeight || 300;

    const mode = viewMode;

    // Axis formatters
    const timeAxisValues = (_u: uPlot, splits: number[]): string[] => {
      const maxVal = Math.max(...splits.map(Math.abs));
      if (maxVal < 1e-6) return splits.map(v => `${(v * 1e9).toFixed(0)}ns`);
      if (maxVal < 1e-3) return splits.map(v => `${(v * 1e6).toFixed(1)}µs`);
      if (maxVal < 1)    return splits.map(v => `${(v * 1e3).toFixed(0)}ms`);
      return splits.map(v => `${v.toFixed(2)}s`);
    };
    const freqAxisValues = (_u: uPlot, splits: number[]): string[] => {
      const maxVal = Math.max(...splits);
      if (maxVal >= 1e6) return splits.map(v => `${(v / 1e6).toFixed(1)}MHz`);
      if (maxVal >= 1e3) return splits.map(v => `${(v / 1e3).toFixed(1)}kHz`);
      return splits.map(v => `${v.toFixed(0)}Hz`);
    };
    const useMV = vpp < 2;
    const voltAxisValues = (_u: uPlot, splits: number[]): string[] => {
      if (useMV) return splits.map(v => `${(v * 1e3).toFixed(0)}mV`);
      return splits.map(v => `${v.toFixed(2)}V`);
    };

    // Draw trigger level line (time mode only)
    const drawTriggerLine = (u: uPlot) => {
      if (mode !== "time") return;
      const level = triggerRef.current.level;
      const posOff = (triggerRef.current.source === "ch2"
        ? ch2Vertical.position * ch2Vertical.vDiv
        : ch1Vertical.position * ch1Vertical.vDiv);
      const ctx = u.ctx;
      const plotTop = u.bbox.top;
      const plotH = u.bbox.height;
      const plotLeft = u.bbox.left;
      const plotRight = plotLeft + u.bbox.width;
      // Match the y-axis range used in the plot config
      const yRange = ch1Vertical.vDiv * 10;
      const vmin = -yRange / 2 + posOff;
      const vmax = yRange / 2 + posOff;
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
      ctx.fillStyle = "#FF00FF";
      ctx.font = "10px monospace";
      ctx.fillText(`${level.toFixed(2)}V`, plotRight - 45, y - 4);
      ctx.restore();
    };

    // Digital phosphor draw hook — trace echo: draw fading copies of past traces
    const drawPhosphor = (u: uPlot) => {
      if (!phosphorEnabledRef.current || phosphorTraces.current.length === 0) return;
      const ctx = u.ctx;
      const traces = phosphorTraces.current;
      const n = traces.length;
      const currentX = u.data[0] as (Float64Array | number[] | undefined);
      if (!currentX || currentX.length === 0) return;
      // Skip the newest trace — uPlot already drew it at full opacity.
      for (let t = 0; t < n - 1; t++) {
        const snap = traces[t];
        const age = n - 1 - t; // 1 = oldest in buffer
        const opacity = Math.max(0, 1 - age / MAX_PHOSPHOR_TRACES) * 0.35;
        if (opacity <= 0) continue;
        // Time mode: use current plot's x-data as template so all ghosts align horizontally
        // XY mode: each snapshot carries its own x-values (CH1 voltage)
        const xSrc = snap.mode === "time" ? currentX : snap.xs;
        if (!xSrc) continue;
        const len = Math.min(xSrc.length, snap.ys1.length, snap.ys2.length);
        // CH1 echo
        ctx.beginPath();
        ctx.strokeStyle = `rgba(245,158,11,${opacity})`;
        ctx.lineWidth = 1;
        let first = true;
        for (let i = 0; i < len; i++) {
          const x = u.valToPos(xSrc[i], "x", true);
          const y = u.valToPos(snap.ys1[i], "y", true);
          if (x == null || y == null) continue;
          if (first) { ctx.moveTo(x, y); first = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
        // CH2 echo
        ctx.beginPath();
        ctx.strokeStyle = `rgba(96,165,250,${opacity})`;
        ctx.lineWidth = 1;
        first = true;
        for (let i = 0; i < len; i++) {
          const x = u.valToPos(xSrc[i], "x", true);
          const y = u.valToPos(snap.ys2[i], "y", true);
          if (x == null || y == null) continue;
          if (first) { ctx.moveTo(x, y); first = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
      }
    };

    let opts: uPlot.Options;

    if (mode === "fft") {
      opts = {
        width: W, height: H,
        padding: [0, 0, 0, 0],
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: "Frequency", values: freqAxisValues },
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: "Magnitude" },
        ],
        series: [
          {},
          { stroke: "#4ADE80", width: 1.5, label: "FFT", show: true },
          { stroke: "#60A5FA", width: 1.5, label: "CH2", show: false },
          { stroke: "#4ADE80", width: 1.5, label: "MATH", show: false },
        ],
        cursor: { show: true, drag: { x: false, y: false } },
        hooks: { drawClear: [drawPhosphor] },
      };
    } else if (mode === "xy") {
      opts = {
        width: W, height: H,
        padding: [0, 0, 0, 0],
        scales: { x: { auto: true }, y: { auto: true } },
        axes: [
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: useMV ? "mV" : "V", values: voltAxisValues },
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: useMV ? "mV" : "V", values: voltAxisValues },
        ],
        series: [
          {},
          { stroke: "#4ADE80", width: 1.5, label: "XY", show: true },
          { stroke: "#60A5FA", width: 1.5, label: "CH2", show: false },
          { stroke: "#4ADE80", width: 1.5, label: "MATH", show: false },
        ],
        cursor: { show: true, drag: { x: false, y: false } },
        hooks: { drawClear: [drawPhosphor] },
      };
    } else {
      opts = {
        width: W, height: H,
        padding: [0, 0, 0, 0],
        scales: { x: { time: false } },
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
        cursor: { show: true, drag: { x: false, y: false } },
        hooks: { drawClear: [drawTriggerLine, drawPhosphor] },
      };
    }
    plotRef.current = new uPlot(opts, [[], [], [], []], container);
    if (mode === "time") {
      const posOffset = (triggerRef.current.source === "ch2"
        ? ch2Vertical.position * ch2Vertical.vDiv
        : ch1Vertical.position * ch1Vertical.vDiv);
      const yRange = ch1Vertical.vDiv * 10;
      const yMin = -yRange / 2 + posOffset;
      const yMax = yRange / 2 + posOffset;
      const initXMax = windowMs / 1000;
      const initDelay = (horizontal.position / 100) * initXMax;
      plotRef.current.setScale('x', { min: initDelay, max: initXMax + initDelay });
      plotRef.current.setScale('y', { min: yMin, max: yMax });

      // Overview plot
      if (overviewContainer) {
        const oW = overviewContainer.offsetWidth || W;
        const oH = overviewContainer.offsetHeight || 80;
        const drawZoomBox = (u: uPlot) => {
          const main = plotRef.current;
          if (!main) return;
          const xMin = main.scales.x.min ?? 0;
          const xMax = main.scales.x.max ?? 0;
          const left = u.valToPos(xMin, 'x', true);
          const right = u.valToPos(xMax, 'x', true);
          if (left == null || right == null) return;
          const plotTop = u.bbox.top;
          const plotBottom = plotTop + u.bbox.height;
          const ctx = u.ctx;
          ctx.save();
          ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
          ctx.fillRect(left, plotTop, right - left, plotBottom - plotTop);
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
          ctx.lineWidth = 1;
          ctx.strokeRect(left, plotTop, right - left, plotBottom - plotTop);
          ctx.restore();
        };
        const oOpts: uPlot.Options = {
          width: oW, height: oH,
          padding: [0, 0, 0, 0],
          scales: { x: { time: false }, y: { auto: true } },
          axes: [
            { stroke: "#666688", grid: { stroke: "#1A1A2E" }, values: timeAxisValues, size: 18 },
            { stroke: "#666688", grid: { stroke: "#1A1A2E" }, size: 18 },
          ],
          series: [
            {},
            { stroke: "#F59E0B", width: 1, label: "CH1" },
            { stroke: "#60A5FA", width: 1, label: "CH2", show: ch2Vertical.enabled },
            { stroke: "#4ADE80", width: 1, label: "MATH", show: math.enabled },
          ],
          cursor: { show: false, drag: { x: false, y: false } },
          hooks: { draw: [drawZoomBox] },
        };
        overviewPlotRef.current = new uPlot(oOpts, [[], [], [], []], overviewContainer);
      }
    }
  }, [vpp, ch1Vertical.vDiv, ch2Vertical.vDiv, ch2Vertical.enabled, math.enabled, ch1Vertical.position, ch2Vertical.position, trigger.level, horizontal.position, viewMode]);

  useEffect(() => {
    const div = plotDivRef.current;
    const odiv = overviewDivRef.current;
    if (!div) return;
    buildPlot(div, odiv ?? undefined);

    // Custom panning (click-drag) and wheel zoom
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let panStartXMin = 0, panStartXMax = 0, panStartYMin = 0, panStartYMax = 0;

    const onMouseDown = (e: MouseEvent) => {
      const amode = acquireModeRef.current;
      if (amode === "running" || amode === "rolling" || amode === "single-armed" || amode === "averaging") return;
      if (e.button !== 0) return;
      const plot = plotRef.current;
      if (!plot) return;
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartXMin = plot.scales.x.min ?? 0;
      panStartXMax = plot.scales.x.max ?? 0;
      panStartYMin = plot.scales.y.min ?? 0;
      panStartYMax = plot.scales.y.max ?? 0;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isPanning) return;
      const plot = plotRef.current;
      if (!plot) return;
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      const pw = plot.bbox.width;
      const ph = plot.bbox.height;
      if (!pw || !ph) return;
      const xShift = (dx / pw) * (panStartXMax - panStartXMin);
      const yShift = (dy / ph) * (panStartYMax - panStartYMin);
      plot.setScale('x', { min: panStartXMin - xShift, max: panStartXMax - xShift });
      plot.setScale('y', { min: panStartYMin + yShift, max: panStartYMax + yShift });
    };
    const onMouseUp = () => { isPanning = false; };

    const onWheel = (e: WheelEvent) => {
      const amode = acquireModeRef.current;
      if (amode === "running" || amode === "rolling" || amode === "single-armed" || amode === "averaging") return;
      e.preventDefault();
      const plot = plotRef.current;
      if (!plot) return;
      const factor = e.deltaY < 0 ? 0.85 : 1.15;
      const xMin = plot.scales.x.min ?? 0;
      const xMax = plot.scales.x.max ?? 0;
      const yMin = plot.scales.y.min ?? 0;
      const yMax = plot.scales.y.max ?? 0;
      const rect = div.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const pl = plot.bbox.left;
      const pt = plot.bbox.top;
      const pw = plot.bbox.width;
      const ph = plot.bbox.height;
      if (mx < pl || mx > pl + pw || my < pt || my > pt + ph) return;
      const fx = (mx - pl) / pw;
      const fy = (my - pt) / ph;
      const xRange = (xMax - xMin) * factor;
      const yRange = (yMax - yMin) * factor;
      const nxMin = xMin + (xMax - xMin) * fx - xRange * fx;
      const nxMax = nxMin + xRange;
      const nyMin = yMin + (yMax - yMin) * (1 - fy) - yRange * (1 - fy);
      const nyMax = nyMin + yRange;
      plot.setScale('x', { min: nxMin, max: nxMax });
      plot.setScale('y', { min: nyMin, max: nyMax });
    };

    div.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    div.addEventListener('wheel', onWheel, { passive: false });

    // Overview click-to-center
    const onOverviewClick = (e: MouseEvent) => {
      const oplot = overviewPlotRef.current;
      const main = plotRef.current;
      if (!oplot || !main) return;
      const amode = acquireModeRef.current;
      if (amode === "running" || amode === "rolling" || amode === "single-armed" || amode === "averaging") return;
      const rect = odiv?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const val = oplot.posToVal(mx, 'x');
      const xMin = main.scales.x.min ?? 0;
      const xMax = main.scales.x.max ?? 0;
      const halfSpan = (xMax - xMin) / 2;
      main.setScale('x', { min: val - halfSpan, max: val + halfSpan });
    };
    odiv?.addEventListener('mousedown', onOverviewClick);

    const ro = new ResizeObserver(() => {
      plotRef.current?.setSize({ width: div.offsetWidth, height: div.offsetHeight });
      if (odiv) overviewPlotRef.current?.setSize({ width: odiv.offsetWidth, height: odiv.offsetHeight });
    });
    ro.observe(div);
    if (odiv) ro.observe(odiv);
    return () => {
      div.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      div.removeEventListener('wheel', onWheel);
      odiv?.removeEventListener('mousedown', onOverviewClick);
      ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null;
      overviewPlotRef.current?.destroy(); overviewPlotRef.current = null;
    };
  }, [buildPlot]);

  // Data push handler
  const pushData = useCallback((chunk: UsbDataChunk) => {
    const bytes = chunk.data ?? Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
    const gain = vpp / 256;

    for (let i = 0; i + 1 < bytes.length; i += 2) {
      let v1 = (bytes[i]   - 128) * gain * ch1VerticalRef.current.probe;
      let v2 = (bytes[i+1] - 128) * gain * ch2VerticalRef.current.probe;

      if (ch1VerticalRef.current.invert) v1 = -v1;
      if (ch2VerticalRef.current.invert) v2 = -v2;

      // BW limit: simple exponential moving average (digital LPF)
      if (ch1VerticalRef.current.bwLimit) {
        const alpha = 0.3; // ~20MHz equivalent at 4MS/s
        v1 = filtRing1.current.length > 0 ? alpha * v1 + (1 - alpha) * filtRing1.current[filtRing1.current.length - 1] : v1;
      }
      if (ch2VerticalRef.current.bwLimit) {
        const alpha = 0.3;
        v2 = filtRing2.current.length > 0 ? alpha * v2 + (1 - alpha) * filtRing2.current[filtRing2.current.length - 1] : v2;
      }

      ch1Buf.current.push(v1);
      ch2Buf.current.push(v2);
      filtRing1.current.push(v1);
      filtRing2.current.push(v2);
    }

    // Trim filter rings alongside buffers
    if (filtRing1.current.length > ch1Buf.current.length) {
      filtRing1.current = filtRing1.current.slice(-ch1Buf.current.length);
      filtRing2.current = filtRing2.current.slice(-ch2Buf.current.length);
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

    // Trigger detection helper — returns crossing index or -1
    const findTriggerIndex = (buf: number[]): number => {
      if (buf.length < 100) return -1;
      const level = triggerRef.current.level;
      const slope = triggerRef.current.slope;
      const sr = sampleRateRef.current || 4_000_000;
      const windowSamples = Math.max(500, Math.ceil(sr * 0.001)); // ~1ms worth of samples
      const checkStart = Math.max(0, buf.length - windowSamples);
      for (let i = checkStart + 1; i < buf.length; i++) {
        const prev = buf[i - 1], curr = buf[i];
        if (slope === "rise" && prev <= level && curr > level) return i;
        if (slope === "fall" && prev >= level && curr < level) return i;
        if (slope === "both" && ((prev <= level && curr > level) || (prev >= level && curr < level))) return i;
      }
      return -1;
    };
    const detectTrigger = (buf: number[]): boolean => findTriggerIndex(buf) >= 0;

    // Render helper — mode-aware: time / fft / xy
    const renderNow = (ch1: number[], ch2: number[], opts?: { phosphorOnly?: boolean }) => {
      forceTriggerRef.current = () => renderNow(ch1Buf.current, ch2Buf.current);
      plotThrottleRef.current = nowPerf;
      const plot = plotRef.current;
      if (!plot) return;
      const n = ch1.length;
      const width = plot.width ?? 1000;
      const target = Math.max(1000, width * 2);
      const vm = viewMode;

      if (vm === "fft") {
        const src = mathRef.current.sourceA === "ch2" ? ch2 : ch1;
        if (src.length < 16) return;
        const { freqs, mags } = fftMagnitude(src, sampleRateRef.current);
        const fn = freqs.length;
        const fArr = new Float64Array(fn);
        const mArr = new Float64Array(fn);
        for (let i = 0; i < fn; i++) { fArr[i] = freqs[i]; mArr[i] = mags[i]; }
        plot.setData([fArr, mArr, new Float64Array(fn), new Float64Array(fn)]);
        return;
      }

      if (vm === "xy") {
        const a = mathRef.current.sourceA === "ch2" ? ch2 : ch1;
        const b = mathRef.current.sourceB === "ch2" ? ch2 : ch1;
        const len = Math.min(a.length, b.length);
        if (len < 2) return;
        const xs = new Float64Array(len);
        const ys = new Float64Array(len);
        for (let i = 0; i < len; i++) { xs[i] = a[i]; ys[i] = b[i]; }
        plot.setData([xs, ys, new Float64Array(len), new Float64Array(len)]);
        // Phosphor for XY: store as trace snapshots (x=chA, y=chB)
        if (phosphorEnabledRef.current) {
          const snap: TraceSnapshot = {
            mode: "xy",
            xs: new Float64Array(a.slice(0, len)),
            ys1: new Float64Array(b.slice(0, len)),
            ys2: new Float64Array(len), // unused in XY
          };
          phosphorTraces.current.push(snap);
          if (phosphorTraces.current.length > MAX_PHOSPHOR_TRACES) {
            phosphorTraces.current.shift();
          }
        }
        return;
      }

      // time mode (with optional peak detect decimation)
      const isPeak = horizontalRef.current.acquireMode === "peak";
      let r1 = ch1, r2 = ch2;
      if (isPeak && n > target) {
        const step = Math.floor(n / target);
        r1 = []; r2 = [];
        for (let i = 0; i < n; i += step) {
          const end = Math.min(i + step, n);
          let min1 = ch1[i], max1 = ch1[i];
          let min2 = ch2[i], max2 = ch2[i];
          for (let j = i + 1; j < end; j++) {
            if (ch1[j] < min1) min1 = ch1[j]; if (ch1[j] > max1) max1 = ch1[j];
            if (ch2[j] < min2) min2 = ch2[j]; if (ch2[j] > max2) max2 = ch2[j];
          }
          r1.push(min1, max1); r2.push(min2, max2);
        }
      }
      const rn = r1.length;

      const doMath = mathRef.current.enabled && mathRef.current.op !== "fft" && mathRef.current.op !== "xy";
      if (doMath) {
        const a = mathRef.current.sourceA === "ch2" ? r2 : r1;
        const b = mathRef.current.sourceB === "ch2" ? r2 : r1;
        mathBuf.current = new Array(rn).fill(0);
        for (let i = 0; i < rn; i++) {
          const av = a[i] ?? 0, bv = b[i] ?? 0;
          const op = mathRef.current.op;
          if (op === "add") mathBuf.current[i] = av + bv;
          else if (op === "sub") mathBuf.current[i] = av - bv;
          else if (op === "mul") mathBuf.current[i] = av * bv;
          else if (op === "div") mathBuf.current[i] = bv !== 0 ? av / bv : 0;
        }
      }
      const mathArr = doMath ? mathBuf.current : new Array(rn).fill(0);

      // Trigger alignment: find trigger in source buffer and center window
      const tSrc = triggerRef.current.source === "ch2" ? r2 : r1;
      const tIdx = findTriggerIndex(tSrc);
      const sr = sampleRateRef.current || 4_000_000;
      const windowSamples = Math.max(100, Math.ceil(windowMs / 1000 * sr));
      const alignTrigger = tIdx >= 0 && rn > windowSamples;
      let s1 = r1, s2 = r2, sM = mathArr;
      let startIdx = 0;
      if (alignTrigger) {
        const preTrigger = Math.floor(windowSamples * 0.25); // trigger at 25% from left
        const postTrigger = windowSamples - preTrigger;
        startIdx = Math.max(0, tIdx - preTrigger);
        const endIdx = Math.min(rn, tIdx + postTrigger);
        s1 = r1.slice(startIdx, endIdx);
        s2 = r2.slice(startIdx, endIdx);
        sM = mathArr.slice(startIdx, endIdx);
      }
      const sn = s1.length;

      // Phosphor: capture aligned trace snapshot (y-only; x-template comes from current plot)
      if (phosphorEnabledRef.current && sn > 0) {
        const snap: TraceSnapshot = {
          mode: "time",
          ys1: new Float64Array(s1),
          ys2: new Float64Array(s2),
        };
        phosphorTraces.current.push(snap);
        if (phosphorTraces.current.length > MAX_PHOSPHOR_TRACES) {
          phosphorTraces.current.shift();
        }
      }

      if (opts?.phosphorOnly) {
        plot.redraw(false, false);
        return;
      }

      // Render aligned or full
      const doDecimate = sn > target && !isPeak;
      const step = doDecimate ? Math.floor(sn / target) : 1;
      const m = doDecimate ? Math.ceil(sn / step) : sn;
      if (!doDecimate) {
        const xs = Float64Array.from({ length: sn }, (_, i) => (startIdx + i) * dt);
        plot.setData([xs, new Float64Array(s1), new Float64Array(s2), new Float64Array(sM)]);
      } else {
        const xs = new Float64Array(m), ys1 = new Float64Array(m), ys2 = new Float64Array(m), ysM = new Float64Array(m);
        for (let i = 0, j = 0; i < sn; i += step, j++) {
          xs[j] = (startIdx + i) * dt; ys1[j] = s1[i]; ys2[j] = s2[i]; ysM[j] = sM[i];
        }
        plot.setData([xs, ys1, ys2, ysM]);
      }
      // Overview gets full data (no decimation)
      const ov = overviewPlotRef.current;
      if (ov) {
        const xsOv = Float64Array.from({ length: rn }, (_, i) => (startIdx + i) * dt);
        ov.setData([xsOv, new Float64Array(r1), new Float64Array(r2), new Float64Array(mathArr)]);
      }
      // Force scale during active acquisition; allow manual zoom/pan when stopped
      const amode = acquireModeRef.current;
      const isAcquiring = amode === "running" || amode === "rolling" || amode === "single-armed" || amode === "averaging";
      if (isAcquiring) {
        const dataMax = sn > 0 ? (startIdx + (m - 1) * step) * dt : 0;
        const delay = (horizontalRef.current.position / 100) * dataMax;
        const posOffset = (triggerRef.current.source === "ch2"
          ? ch2VerticalRef.current.position * ch2VerticalRef.current.vDiv
          : ch1VerticalRef.current.position * ch1VerticalRef.current.vDiv);
        const yRange = ch1VerticalRef.current.vDiv * 10;
        const yMin = -yRange / 2 + posOffset;
        const yMax = yRange / 2 + posOffset;
        plot.setScale('x', { min: delay, max: dataMax + delay });
        plot.setScale('y', { min: yMin, max: yMax });
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
      const tmode = triggerRef.current.mode;
      if (tmode === "auto") {
        renderNow(ch1Buf.current, ch2Buf.current);
        triggerArmedRef.current = true;
      } else if (tmode === "normal") {
        const triggered = detectTrigger(sourceBuf);
        if (triggered && triggerArmedRef.current) {
          renderNow(ch1Buf.current, ch2Buf.current);
          triggerArmedRef.current = false;
        }
        // Re-arm when signal leaves trigger zone
        if (!triggerArmedRef.current && sourceBuf.length > 0) {
          const last = sourceBuf[sourceBuf.length - 1];
          const level = triggerRef.current.level;
          const slope = triggerRef.current.slope;
          const margin = vpp * 0.05;
          if (slope === "rise" && last < level - margin) triggerArmedRef.current = true;
          if (slope === "fall" && last > level + margin) triggerArmedRef.current = true;
          if (slope === "both" && (last < level - margin || last > level + margin)) triggerArmedRef.current = true;
        }
      } else if (tmode === "smart") {
        const triggered = detectTrigger(sourceBuf);
        if (smartStateRef.current === "auto") {
          renderNow(ch1Buf.current, ch2Buf.current);
          if (triggered) {
            smartTriggerCountRef.current++;
            if (smartTriggerCountRef.current > 6) { // ~300ms at 50ms throttle
              smartStateRef.current = "locked";
              smartMissCountRef.current = 0;
              phosphorTraces.current = []; // clear free-run ghosts, start clean locked history
            }
          } else {
            smartTriggerCountRef.current = 0;
          }
        } else {
          // Locked: trace frozen, phosphor accumulates jitter as fading cloud
          if (triggered) {
            renderNow(ch1Buf.current, ch2Buf.current, { phosphorOnly: true });
            smartMissCountRef.current = 0;
          } else {
            smartMissCountRef.current++;
          }
          // Revert to auto after ~500ms without trigger (10 evaluations at 50ms)
          if (smartMissCountRef.current > 10) {
            smartStateRef.current = "auto";
            smartTriggerCountRef.current = 0;
            smartMissCountRef.current = 0;
            phosphorTraces.current = []; // clear stale ghosts on mode transition
          }
        }
      }
    }
  }, [vpp, windowMs]);

  // Start / stop
  const start = useCallback(async () => {
    if (!connected || runningRef.current) return;
    ch1Buf.current = [];
    ch2Buf.current = [];
    mathBuf.current = [];
    phosphorTraces.current = [];
    filtRing1.current = [];
    filtRing2.current = [];
    plotThrottleRef.current = 0;
    triggerArmedRef.current = true;
    smartStateRef.current = "auto";
    smartTriggerCountRef.current = 0;
    smartMissCountRef.current = 0;
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
    phosphorTraces.current = [];
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
      setTrigger(prev => ({ ...prev, level: result.triggerLevel, source: result.source }));
    }
  };
  const handleForceTrigger = () => {
    // One-shot: render current buffers immediately regardless of trigger state
    forceTriggerRef.current?.();
  };
  const handleSetTrigger50Percent = () => {
    const buf = ch1Buf.current.length > 10 ? ch1Buf.current : ch2Buf.current;
    if (buf.length < 10) return;
    const mid = (Math.max(...buf) + Math.min(...buf)) / 2;
    setTrigger(prev => ({ ...prev, level: mid }));
  };
  const handleClear = () => {
    ch1Buf.current = []; ch2Buf.current = []; mathBuf.current = [];
    phosphorTraces.current = [];
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
        <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-1">
          <div ref={plotDivRef} className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0 min-w-0" />
          {viewMode === "time" && (
            <div ref={overviewDivRef} className="h-20 rounded border border-fob-border overflow-hidden bg-fob-surface shrink-0 min-w-0" />
          )}
        </div>

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
          {/* Display / Phosphor */}
          <div className="flex items-center gap-1.5 border-t border-fob-border pt-1">
            <label className="flex items-center gap-1 text-[10px] text-fob-text-dim">
              <input
                type="checkbox"
                checked={phosphorEnabled}
                onChange={(e) => setPhosphorEnabled(e.target.checked)}
                className="accent-fob-orange"
              />
              Digital Phosphor
            </label>
          </div>
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
