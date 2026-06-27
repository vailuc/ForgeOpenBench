import { useRef, useEffect, useCallback, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { UsbTransport } from "./UsbTransport";
import type { UsbDataChunk } from "./usbTypes";

/* ── Types ─────────────────────────────────────────────────────────── */
// Types used by calcMeasurements, ch1Meas, ch2Meas
interface Measurements { vpp: number; dc: number; vrms: number; freq: number }

/* ── Measurement helpers ─────────────────────────────────────────────── */
function calcMeasurements(buf: number[], rate: number): Measurements {
  if (buf.length < 2) return { vpp: 0, dc: 0, vrms: 0, freq: 0 };
  let min = buf[0], max = buf[0], sum = 0, sumSq = 0;
  for (const v of buf) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const dc = sum / buf.length;
  // Zero-crossing frequency estimate
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i-1] <= dc && buf[i] > dc) || (buf[i-1] >= dc && buf[i] < dc)) crossings++;
  }
  const period = crossings > 0 ? (buf.length / rate) / (crossings / 2) : 0;
  return {
    vpp: max - min,
    dc,
    vrms: Math.sqrt(sumSq / buf.length),
    freq: period > 0 ? 1 / period : 0,
  };
}

const TIMEBASE_OPTIONS = [
  { label: "Auto",   ms: 0 },   // 0 = auto-compute from test signal
  { label: "2 ms",   ms: 2 },
  { label: "5 ms",   ms: 5 },
  { label: "10 ms",  ms: 10 },
  { label: "20 ms",  ms: 20 },
  { label: "50 ms",  ms: 50 },
  { label: "100 ms", ms: 100 },
  { label: "200 ms", ms: 200 },
  { label: "500 ms", ms: 500 },
];

const TEST_SIGNAL_FREQS: Record<string, number> = {
  "off":    0,
  "32 Hz":  32,
  "50 Hz":  50,
  "100 Hz": 100,
  "200 Hz": 200,
  "500 Hz": 500,
  "1 kHz":  1000,
  "2 kHz":  2000,
  "5 kHz":  5000,
  "10 kHz": 10000,
  "50 kHz": 50000,
  "100 kHz": 100000,
};

function getWindowMs(timebaseMs: number, testSignal: string): number {
  if (timebaseMs !== 0) return timebaseMs;
  const freq = TEST_SIGNAL_FREQS[testSignal] || 0;
  if (freq === 0) return 20;
  const periodMs = 1000 / freq;
  return Math.max(5, Math.round(periodMs * 10)); // ~10 periods, min 5ms
}

const SAMPLE_RATES_DSO = [
  { label: "48 MS/s",  hz: 48_000_000 },
  { label: "30 MS/s",  hz: 30_000_000 },
  { label: "24 MS/s",  hz: 24_000_000 },
  { label: "16 MS/s",  hz: 16_000_000 },
  { label: "15 MS/s",  hz: 15_000_000 },
  { label: "12 MS/s",  hz: 12_000_000 },
  { label: "10 MS/s",  hz: 10_000_000 },
  { label: "8 MS/s",   hz: 8_000_000 },
  { label: "6 MS/s",   hz: 6_000_000 },
  { label: "5 MS/s",   hz: 5_000_000 },
  { label: "4 MS/s",   hz: 4_000_000 },
  { label: "3 MS/s",   hz: 3_000_000 },
  { label: "2 MS/s",   hz: 2_000_000 },
  { label: "1 MS/s",   hz: 1_000_000 },
  { label: "500 kS/s", hz:   500_000 },
  { label: "200 kS/s", hz:   200_000 },
  { label: "100 kS/s", hz:   100_000 },
  { label: "50 kS/s",  hz:    50_000 },
  { label: "20 kS/s",  hz:    20_000 },
];

// Actual hardware Vpp (double the ± range).  8-bit ADC: gain = vpp / 256
const VOLT_RANGES = [
  { label: "±5 V",   vpp: 10.0,  code: 1  },  // 1 LSB = 39.06 mV
  { label: "±2.5 V", vpp: 5.0,   code: 2  },  // 1 LSB = 19.53 mV
  { label: "±1 V",   vpp: 2.0,   code: 5  },  // 1 LSB = 7.81 mV
  { label: "±500 mV", vpp: 1.0,  code: 10 },  // 1 LSB = 3.91 mV
];

interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
}

export function WaveformDsoView({ transport, isActive, connected }: Props) {
  const plotDivRef = useRef<HTMLDivElement>(null);
  const plotRef    = useRef<uPlot | null>(null);
  const runningRef  = useRef(false);
  const pausedRef   = useRef(false);
  const dataOffRef  = useRef<(() => void) | null>(null);
  const ch1Buf      = useRef<number[]>([]);
  const ch2Buf      = useRef<number[]>([]);

  // Refs for values that async handlers need to read live (avoid stale closure)
  const sampleRateRef = useRef(4_000_000);
  const voltRangeRef = useRef(1.0);
  const testSignalRef = useRef("off");
  const ch1OffsetRef = useRef(0);
  const ch2OffsetRef = useRef(0);
  const timebaseMsRef = useRef(0);
  const phosphorRef = useRef(false);
  const showHistRef = useRef(true);
  const filterJitterRef = useRef(false);
  const persistMsRef = useRef(5000);
  const connectedRef = useRef(connected);
  const intentionalStopRef = useRef(false);
  const startRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  const [running,    setRunning]    = useState(false);
  const [paused,     setPaused]     = useState(false);
  const [sampleRate, setSampleRate] = useState(4_000_000);
  const [voltRange,  setVoltRange]  = useState(1.0); // vpp
  const [ch1Offset,  setCh1Offset]  = useState(0);   // DC offset mV
  const [ch2Offset,  setCh2Offset]  = useState(0);
  const [showCh2,    setShowCh2]    = useState(true);
  const [testSignal, setTestSignal] = useState("off"); // test signal frequency
  const [isApplying, setIsApplying] = useState(false); // test signal apply in progress
  const [timebaseMs, setTimebaseMs] = useState(0); // 0=Auto, else fixed window in ms

  // Pro layout toggles
  const [layout,     setLayout]     = useState<"basic" | "pro">("pro");
  const [showHist,   setShowHist]   = useState(true);
  const [persistMs,  setPersistMs]  = useState(5000); // 2-10s adjustable history buffer
  const [phosphor,   setPhosphor]   = useState(false);
  const [filterJitter, setFilterJitter] = useState(false); // 3-point median deglitch

  // Live measurements (state so bottom bar re-renders)
  const [ch1Meas, setCh1Meas] = useState<Measurements>({ vpp: 0, dc: 0, vrms: 0, freq: 0 });
  const [ch2Meas, setCh2Meas] = useState<Measurements>({ vpp: 0, dc: 0, vrms: 0, freq: 0 });
  const measThrottleRef = useRef(0);
  const plotThrottleRef = useRef(0); // last plot redraw timestamp

  // Trace persistence buffer (time-based, max 10 seconds) — stores both CH1 & CH2
  interface PersistPoint { ch1: number; ch2: number; ts: number }
  const persistBuf = useRef<PersistPoint[]>([]);

  // Jitter filter ring buffers (3-sample median)
  const filtRing1 = useRef<number[]>([]);
  const filtRing2 = useRef<number[]>([]);

  // Auto-start when connected (live mode)
  useEffect(() => {
    if (connected && !runningRef.current && !pausedRef.current) {
      void start();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const GUTTER = 200; // px width for compressed trace history gutter (~25% of plot)

  const buildPlot = useCallback((container: HTMLDivElement) => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null; }
    const W = container.offsetWidth  || 600;
    const H = container.offsetHeight || 300;

    // DSO-style axis value formatters — auto-switch units like Rigol/Keysight
    const timeAxisValues = (_u: uPlot, splits: number[]): string[] => {
      const maxVal = Math.max(...splits.map(Math.abs));
      if (maxVal < 1e-6) return splits.map(v => `${(v * 1e9).toFixed(0)}ns`);
      if (maxVal < 1e-3) return splits.map(v => `${(v * 1e6).toFixed(1)}µs`);
      if (maxVal < 1)    return splits.map(v => `${(v * 1e3).toFixed(0)}ms`);
      return splits.map(v => `${v.toFixed(2)}s`);
    };

    const useMV = voltRange < 2;  // show mV for ±500mV / ±1V ranges
    const voltAxisValues = (_u: uPlot, splits: number[]): string[] => {
      if (useMV) return splits.map(v => `${(v * 1e3).toFixed(0)}mV`);
      return splits.map(v => `${v.toFixed(2)}V`);
    };

    // Draw compressed trace history inside the plot area (faint persistence ghost)
    const drawPersist = (u: uPlot) => {
      if (!showHist) return;
      const buf = persistBuf.current;
      if (buf.length < 2) return;
      const ctx = u.ctx;
      const gutterW = GUTTER; // width inside plot area
      const plotTop = u.bbox.top;
      const plotH = u.bbox.height;
      const left = u.bbox.left; // start INSIDE plot area, not at canvas edge
      const pad = 4;
      const vmin = -voltRange / 2;
      const vmax = voltRange / 2;
      const yScale = (plotH - pad * 2) / (vmax - vmin);
      const yOfs = plotTop + plotH - pad;

      ctx.save();
      // Faint vertical divider between history zone and live trace
      ctx.strokeStyle = "#333355";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(left + gutterW, plotTop);
      ctx.lineTo(left + gutterW, plotTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // CH1 compressed trace (orange) — faint ghost inside plot area
      ctx.strokeStyle = "#F59E0B";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (let px = 0; px < gutterW; px++) {
        const iStart = Math.floor((px / gutterW) * buf.length);
        const iEnd = Math.min(buf.length, Math.floor(((px + 1) / gutterW) * buf.length));
        let pmin = buf[iStart].ch1, pmax = buf[iStart].ch1;
        for (let j = iStart + 1; j < iEnd; j++) {
          if (buf[j].ch1 < pmin) pmin = buf[j].ch1;
          if (buf[j].ch1 > pmax) pmax = buf[j].ch1;
        }
        const y1 = yOfs - (pmin - vmin) * yScale;
        const y2 = yOfs - (pmax - vmin) * yScale;
        const x = left + px;
        if (px === 0) { ctx.moveTo(x, y1); ctx.lineTo(x, y2); }
        else { ctx.lineTo(x, y1); ctx.lineTo(x, y2); }
      }
      ctx.stroke();

      // CH2 compressed trace (blue)
      ctx.strokeStyle = "#60A5FA";
      ctx.beginPath();
      for (let px = 0; px < gutterW; px++) {
        const iStart = Math.floor((px / gutterW) * buf.length);
        const iEnd = Math.min(buf.length, Math.floor(((px + 1) / gutterW) * buf.length));
        let pmin = buf[iStart].ch2, pmax = buf[iStart].ch2;
        for (let j = iStart + 1; j < iEnd; j++) {
          if (buf[j].ch2 < pmin) pmin = buf[j].ch2;
          if (buf[j].ch2 > pmax) pmax = buf[j].ch2;
        }
        const y1 = yOfs - (pmin - vmin) * yScale;
        const y2 = yOfs - (pmax - vmin) * yScale;
        const x = left + px;
        if (px === 0) { ctx.moveTo(x, y1); ctx.lineTo(x, y2); }
        else { ctx.lineTo(x, y1); ctx.lineTo(x, y2); }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    const opts: uPlot.Options = {
      width: W, height: H,
      padding: [0, 0, 0, 0], // no extra padding — history draws inside plot area
      scales: { x: { time: false }, y: { range: [-voltRange / 2, voltRange / 2] } },
      axes: [
        { stroke: "#666688", grid: { stroke: "#1A1A2E" }, values: timeAxisValues },
        { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: useMV ? "mV" : "V", values: voltAxisValues },
      ],
      series: [
        {},
        { stroke: "#F59E0B", width: 1.5, label: "CH1" },
        { stroke: "#60A5FA", width: 1.5, label: "CH2", show: showCh2 },
      ],
      cursor: { show: true },
      hooks: {
        drawClear: [drawPersist],
      },
    };
    plotRef.current = new uPlot(opts, [[], [], []], container);
  }, [voltRange, showCh2, showHist]);

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

  const pushData = useCallback((chunk: UsbDataChunk) => {
    const bytes = chunk.data ?? Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
    // Read from refs so changes apply immediately without re-registering the handler
    const vRange = voltRangeRef.current;
    const gain = vRange / 256;
    const jitter = filterJitterRef.current;
    const tb = timebaseMsRef.current;
    const sig = testSignalRef.current;
    const persist = phosphorRef.current;

    for (let i = 0; i + 1 < bytes.length; i += 2) {
      let v1 = (bytes[i]   - 128) * gain + ch1OffsetRef.current / 1000;
      let v2 = (bytes[i+1] - 128) * gain + ch2OffsetRef.current / 1000;

      // 3-point median filter for edge jitter
      if (jitter) {
        const r1 = filtRing1.current;
        const r2 = filtRing2.current;
        r1.push(v1); if (r1.length > 3) r1.shift();
        r2.push(v2); if (r2.length > 3) r2.shift();
        if (r1.length === 3) v1 = [r1[0], r1[1], r1[2]].sort((a,b) => a-b)[1];
        if (r2.length === 3) v2 = [r2[0], r2[1], r2[2]].sort((a,b) => a-b)[1];
      }

      ch1Buf.current.push(v1);
      ch2Buf.current.push(v2);
    }

    // Window trim — phosphor keeps 3x window so old traces fade out
    const windowMs = getWindowMs(tb, sig);
    const dt = 1 / chunk.rate;
    // Cap buffer so the plot tab doesn't freeze/crash on large windows + high sample rates
    const MAX_SAMPLES = 200_000;
    const maxSamples = Math.min(Math.ceil((persist ? windowMs * 3 : windowMs) / 1000 / dt), MAX_SAMPLES);
    if (ch1Buf.current.length > maxSamples) {
      ch1Buf.current = ch1Buf.current.slice(-maxSamples);
      ch2Buf.current = ch2Buf.current.slice(-maxSamples);
    }

    // Compute live measurements (throttled state update ~5Hz)
    const m1 = calcMeasurements(ch1Buf.current, chunk.rate);
    const m2 = calcMeasurements(ch2Buf.current, chunk.rate);
    const now = Date.now();
    if (now - measThrottleRef.current > 200) {
      measThrottleRef.current = now;
      setCh1Meas(m1);
      setCh2Meas(m2);
    }

    // Append decimated samples to persist buffer with timestamps
    // Cap at 200 points per frame so history stays dense but memory is bounded
    const n = ch1Buf.current.length;
    const maxAdd = 200;
    const step = Math.max(1, Math.floor(n / maxAdd));
    for (let i = step; i < n; i += step) {
      persistBuf.current.push({ ch1: ch1Buf.current[i], ch2: ch2Buf.current[i], ts: now });
    }
    // Auto-clear persist if signal is effectively gone (flatline / no probe)
    if (m1.vpp < 0.02 && m2.vpp < 0.02) {
      persistBuf.current = [];
    }
    // Trim to adjustable persist window (2-10s)
    const CUTOFF = now - persistMsRef.current;
    const firstValid = persistBuf.current.findIndex(p => p.ts >= CUTOFF);
    if (firstValid > 0) {
      persistBuf.current = persistBuf.current.slice(firstValid);
    }

    // Throttle plot redraw to ~20fps max — data still accumulates, display catches up
    const nowPerf = performance.now();
    if (!pausedRef.current && nowPerf - plotThrottleRef.current > 50) {
      plotThrottleRef.current = nowPerf;
      const n   = ch1Buf.current.length;
      // Decimate to ~2x canvas width so uPlot redraws stay fast even at 200k samples
      const width = plotRef.current?.width ?? 1000;
      const target = Math.max(1000, width * 2);
      if (n <= target) {
        const xs = Float64Array.from({ length: n }, (_, i) => i * dt);
        plotRef.current?.setData([xs, new Float64Array(ch1Buf.current), new Float64Array(ch2Buf.current)]);
      } else {
        const step = Math.floor(n / target);
        const m = Math.ceil(n / step);
        const xs  = new Float64Array(m);
        const ys1 = new Float64Array(m);
        const ys2 = new Float64Array(m);
        for (let i = 0, j = 0; i < n; i += step, j++) {
          xs[j] = i * dt;
          ys1[j] = ch1Buf.current[i];
          ys2[j] = ch2Buf.current[i];
        }
        plotRef.current?.setData([xs, ys1, ys2]);
      }
    }
  }, []);

  const start = useCallback(async () => {
    if (!connected || runningRef.current) return;
    ch1Buf.current = [];
    ch2Buf.current = [];
    filtRing1.current = [];
    filtRing2.current = [];
    persistBuf.current = [];
    plotThrottleRef.current = 0;
    try {
      await transport.configure({
        mode: "dso",
        sample_rate_hz: sampleRateRef.current,
        sample_width: 8,
        voltage_range: voltRangeRef.current,
        test_signal: testSignalRef.current
      });
      dataOffRef.current?.();
      dataOffRef.current = transport.onData(pushData);
      await transport.start();
      runningRef.current = true;
      setRunning(true);
    } catch (e) {
      runningRef.current = false;
      setRunning(false);
      console.warn("[DSO] start error", e);
    }
  }, [connected, transport, pushData]);
  useEffect(() => { startRef.current = start; }, [start]);

  const stop = useCallback(async (intentional = false) => {
    intentionalStopRef.current = intentional;
    runningRef.current = false;
    setRunning(false);
    dataOffRef.current?.();
    dataOffRef.current = null;
    // Clear all buffers so next capture starts fresh
    ch1Buf.current = [];
    ch2Buf.current = [];
    filtRing1.current = [];
    filtRing2.current = [];
    persistBuf.current = [];
    try { await transport.stop(); } catch { }
  }, [transport]);

  const applyTestSignal = useCallback(async () => {
    if (!connected || isApplying) return;
    setIsApplying(true);
    // Stop if running, then start() will configure + start with current refs
    if (runningRef.current) {
      await stop();
    }
    try {
      await start();
    } catch (e: any) {
      console.warn("[DSO] apply test signal failed:", e);
    }
    setIsApplying(false);
  }, [connected, isApplying, transport, stop, start]);

  const setTestSignalFreq = useCallback((frequency: string) => {
    setTestSignal(frequency);
    testSignalRef.current = frequency;
  }, []);

  useEffect(() => {
    if (!isActive || !connected) {
      if (runningRef.current) void stop(true);
      else { dataOffRef.current?.(); dataOffRef.current = null; }
    }
  }, [isActive, connected, running, stop]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = transport.onStopped(() => {
      if (!runningRef.current) return;
      runningRef.current = false;
      setRunning(false);
      // Clear buffers so next Run starts fresh
      ch1Buf.current = []; ch2Buf.current = [];
      filtRing1.current = []; filtRing2.current = [];
      persistBuf.current = [];
      // If this stop was triggered by our own stop() call, don't auto-restart.
      if (intentionalStopRef.current) {
        intentionalStopRef.current = false;
        return;
      }
      // If the backend dropped out while we're still connected, wait for it
      // to clean up the USB handle and then restart automatically.
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

  // Sync refs from state so async handlers read live values without stale closure
  useEffect(() => { sampleRateRef.current = sampleRate; }, [sampleRate]);
  useEffect(() => { voltRangeRef.current = voltRange; }, [voltRange]);
  useEffect(() => { testSignalRef.current = testSignal; }, [testSignal]);
  useEffect(() => { ch1OffsetRef.current = ch1Offset; }, [ch1Offset]);
  useEffect(() => { ch2OffsetRef.current = ch2Offset; }, [ch2Offset]);
  useEffect(() => { timebaseMsRef.current = timebaseMs; }, [timebaseMs]);
  useEffect(() => { phosphorRef.current = phosphor; }, [phosphor]);
  useEffect(() => { showHistRef.current = showHist; }, [showHist]);
  useEffect(() => { filterJitterRef.current = filterJitter; }, [filterJitter]);
  useEffect(() => { persistMsRef.current = persistMs; }, [persistMs]);

  // Live reconfigure: stop then start() which configures with current refs
  // (backend no longer auto-restarts on configure; this keeps the frontend in control)
  const liveReconfigure = useCallback(async () => {
    if (!connected || !runningRef.current) return;
    setIsApplying(true);
    try {
      await stop(true);
      await start();
    } catch (e) { console.warn("[DSO] live reconfigure failed:", e); }
    finally { setIsApplying(false); }
  }, [connected, transport, stop, start]);

  const rateLabel = SAMPLE_RATES_DSO.find(r => r.hz === sampleRate)?.label ?? `${sampleRate/1e6}MS/s`;
  const tbLabel = timebaseMs === 0 ? `Auto (${getWindowMs(0, testSignal)}ms)` : `${timebaseMs}ms`;

  /* short measurement formatter */
  const F = (n: number) => {
    if (!Number.isFinite(n)) return "---";
    if (Math.abs(n) < 0.001) return `${(n*1e6).toFixed(0)}µ`;
    if (Math.abs(n) < 1)     return `${(n*1e3).toFixed(1)}m`;
    return `${n.toFixed(2)}`;
  };
  const FF = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return "---";
    if (n >= 1000) return `${(n/1e3).toFixed(2)}kHz`;
    if (n >= 1)    return `${n.toFixed(1)}Hz`;
    return `${(n*1e3).toFixed(1)}mHz`;
  };

  return (
    <div className="flex flex-col h-full gap-1 p-2">
      {/* ====== TOP BAR ====== */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5 text-fob-orange font-bold"
          value={layout} onChange={e => setLayout(e.target.value as "basic" | "pro")}>
          <option value="basic">Basic</option>
          <option value="pro">Pro</option>
        </select>

        {layout === "pro" && (
          <>
            <button onClick={() => { setShowHist(!showHist); if (showHist) { persistBuf.current = []; } }}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${showHist ? "bg-fob-orange/20 border-fob-orange text-fob-orange" : "bg-fob-surface border-fob-border text-fob-text-dim"}`}
              title="Toggle trace history overlay">
              Hist {showHist ? "ON" : "off"}
            </button>
            {showHist && (
              <>
                <select className="bg-fob-surface border border-fob-border rounded px-0.5 py-0.5 text-[10px] text-fob-text-dim"
                  value={persistMs} onChange={e => setPersistMs(Number(e.target.value))}
                  title="History buffer duration">
                  <option value={2000}>2s</option>
                  <option value={5000}>5s</option>
                  <option value={10000}>10s</option>
                </select>
                <button onClick={() => {
                  const now = Date.now();
                  const dtMs = 1000 / sampleRateRef.current;
                  const n = ch1Buf.current.length;
                  // Persist history + full live trace up to the button press
                  const histRows = persistBuf.current.map(p => `${p.ts},${p.ch1.toFixed(4)},${p.ch2.toFixed(4)}`);
                  const liveRows: string[] = [];
                  for (let i = 0; i < n; i++) {
                    const ts = now - (n - 1 - i) * dtMs;
                    liveRows.push(`${ts.toFixed(3)},${ch1Buf.current[i].toFixed(4)},${ch2Buf.current[i].toFixed(4)}`);
                  }
                  const rows = [...histRows, ...liveRows].join("\n");
                  const blob = new Blob(["timestamp,ch1,ch2\n" + rows], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = `trace_hist_${Date.now()}.csv`;
                  a.click(); URL.revokeObjectURL(url);
                }} className="text-[10px] px-1.5 py-0.5 rounded border bg-fob-surface border-fob-border text-fob-text-dim hover:text-fob-orange"
                  title="Save history + full live trace as CSV">
                  Save
                </button>
              </>
            )}
            <button onClick={() => setFilterJitter(!filterJitter)}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${filterJitter ? "bg-fob-orange/20 border-fob-orange text-fob-orange" : "bg-fob-surface border-fob-border text-fob-text-dim"}`}
              title="3-point median filter — removes single-sample edge glitches">
              Filter {filterJitter ? "ON" : "off"}
            </button>
            <button onClick={() => setPhosphor(!phosphor)}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${phosphor ? "bg-fob-orange/20 border-fob-orange text-fob-orange" : "bg-fob-surface border-fob-border text-fob-text-dim"}`}
              title="Persistence — keeps old traces visible (3× window buffer)">
              Persist {phosphor ? "ON" : "off"}
            </button>
            <span className="text-fob-text-dim ml-1">{rateLabel}</span>
            <span className="text-fob-text-dim">|</span>
            <span className="text-fob-text-dim">{tbLabel}</span>
            <span className="text-fob-text-dim">|</span>
            <span className="text-fob-text-dim">{VOLT_RANGES.find(r => r.vpp === voltRange)?.label ?? "±?"}</span>
          </>
        )}

        <div className="flex-1" />

        {running && (
          paused
            ? <button onClick={() => { pausedRef.current = false; setPaused(false); }} disabled={isApplying} className="px-3 py-1 rounded bg-fob-green hover:bg-fob-green/80 text-fob-accent-text disabled:opacity-40 font-bold">Resume</button>
            : <button onClick={() => { pausedRef.current = true; setPaused(true); }} className="px-3 py-1 rounded bg-fob-orange text-fob-accent-text font-bold">Pause</button>
        )}
        {running && (
          <button onClick={() => stop(true)} className="px-3 py-1 rounded bg-fob-red text-fob-text font-bold">Stop</button>
        )}
        {!running && (
          <button onClick={start} disabled={!connected || isApplying} className="px-3 py-1 rounded bg-fob-green hover:bg-fob-green/80 text-fob-accent-text disabled:opacity-40 font-bold">Run</button>
        )}
      </div>

      {/* ====== MAIN AREA ====== */}
      <div className="flex flex-1 gap-1 overflow-hidden min-h-0">
        {/* Plot (with optional left gutter histogram drawn inside) */}
        <div ref={plotDivRef} className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0" />

        {/* --- Right Panel (Pro) --- */}
        {layout === "pro" && (
          <div className="w-44 flex flex-col gap-2 shrink-0 overflow-y-auto text-[11px] px-1">
            {/* Horizontal */}
            <div className="border border-fob-border rounded p-1.5 bg-fob-surface">
              <div className="text-fob-orange font-bold mb-1">HORIZONTAL</div>
              <div className="flex flex-col gap-1">
                <label className="text-fob-text-dim">Timebase</label>
                <select className="bg-fob-bg border border-fob-border rounded px-1 py-0.5"
                  value={timebaseMs} onChange={e => setTimebaseMs(Number(e.target.value))}>
                  {TIMEBASE_OPTIONS.map(t => <option key={t.ms} value={t.ms}>{t.label}</option>)}
                </select>
                <label className="text-fob-text-dim">Samplerate</label>
                <select className="bg-fob-bg border border-fob-border rounded px-1 py-0.5"
                  value={sampleRate} onChange={e => {
                    const hz = Number(e.target.value);
                    setSampleRate(hz);
                    sampleRateRef.current = hz;
                    liveReconfigure();
                  }} disabled={isApplying}>
                  {SAMPLE_RATES_DSO.map(r => <option key={r.hz} value={r.hz}>{r.label}</option>)}
                </select>
              </div>
            </div>

            {/* Voltage */}
            <div className="border border-fob-border rounded p-1.5 bg-fob-surface">
              <div className="text-fob-orange font-bold mb-1">VOLTAGE</div>
              <div className="flex flex-col gap-1">
                <label className="text-fob-text-dim">CH1 Range</label>
                <select className="bg-fob-bg border border-fob-border rounded px-1 py-0.5"
                  value={voltRange} onChange={e => {
                    const vpp = Number(e.target.value);
                    setVoltRange(vpp);
                    voltRangeRef.current = vpp;
                    liveReconfigure();
                  }} disabled={isApplying}>
                  {VOLT_RANGES.map(r => <option key={r.vpp} value={r.vpp}>{r.label}</option>)}
                </select>
                <label className="text-fob-text-dim">CH1 Offset</label>
                <div className="flex items-center gap-1">
                  <button onClick={() => setCh1Offset(Math.max(-voltRange * 500, ch1Offset - 10))}
                    className="px-1.5 rounded bg-fob-bg border border-fob-border hover:bg-fob-border">-</button>
                  <input type="range" min={-voltRange * 500} max={voltRange * 500} step={1}
                    value={ch1Offset} onChange={e => setCh1Offset(Number(e.target.value))}
                    className="flex-1 min-w-0 accent-fob-orange" />
                  <button onClick={() => setCh1Offset(Math.min(voltRange * 500, ch1Offset + 10))}
                    className="px-1.5 rounded bg-fob-bg border border-fob-border hover:bg-fob-border">+</button>
                </div>
                <input type="number" className="w-full bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-xs"
                  value={ch1Offset} onChange={e => setCh1Offset(Number(e.target.value))} />
                <label className="text-fob-text-dim flex items-center gap-1 mt-1">
                  <input type="checkbox" checked={showCh2} onChange={e => setShowCh2(e.target.checked)} disabled={running} />
                  CH2
                </label>
                {showCh2 && (
                  <>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setCh2Offset(Math.max(-voltRange * 500, ch2Offset - 10))}
                        className="px-1.5 rounded bg-fob-bg border border-fob-border hover:bg-fob-border">-</button>
                      <input type="range" min={-voltRange * 500} max={voltRange * 500} step={1}
                        value={ch2Offset} onChange={e => setCh2Offset(Number(e.target.value))}
                        className="flex-1 min-w-0 accent-fob-blue" />
                      <button onClick={() => setCh2Offset(Math.min(voltRange * 500, ch2Offset + 10))}
                        className="px-1.5 rounded bg-fob-bg border border-fob-border hover:bg-fob-border">+</button>
                    </div>
                    <input type="number" className="w-full bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-xs"
                      value={ch2Offset} onChange={e => setCh2Offset(Number(e.target.value))} />
                  </>
                )}
              </div>
            </div>

            {/* Calibration */}
            <div className="border border-fob-border rounded p-1.5 bg-fob-surface">
              <div className="text-fob-orange font-bold mb-1">CAL OUT</div>
              <select className="bg-fob-bg border border-fob-border rounded px-1 py-0.5 w-full"
                value={testSignal} onChange={e => setTestSignalFreq(e.target.value)} disabled={!connected}>
                {Object.keys(TEST_SIGNAL_FREQS).map(f => (
                  <option key={f} value={f}>{f === "off" ? "Off" : f}</option>
                ))}
              </select>
              <button onClick={applyTestSignal} disabled={!connected || isApplying}
                className="mt-1 w-full px-2 py-0.5 rounded bg-fob-orange hover:bg-fob-orange/80 disabled:opacity-40 text-xs font-bold">
                {isApplying ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ====== BOTTOM MEASUREMENTS (Pro) ====== */}
      {layout === "pro" && (
        <div className="flex items-center gap-4 text-[11px] font-mono text-fob-text-dim border-t border-fob-border pt-1 shrink-0 overflow-hidden">
          <span className="text-fob-orange shrink-0">CH1</span>
          <span className="shrink-0">Vpp {F(ch1Meas.vpp)}</span>
          <span className="shrink-0">= {F(ch1Meas.dc)}</span>
          <span className="shrink-0">rms {F(ch1Meas.vrms)}</span>
          <span className="shrink-0">{FF(ch1Meas.freq)}</span>
          {showCh2 && (
            <>
              <span className="text-fob-blue shrink-0 ml-2">CH2</span>
              <span className="shrink-0">Vpp {F(ch2Meas.vpp)}</span>
              <span className="shrink-0">= {F(ch2Meas.dc)}</span>
              <span className="shrink-0">rms {F(ch2Meas.vrms)}</span>
              <span className="shrink-0">{FF(ch2Meas.freq)}</span>
            </>
          )}
        </div>
      )}

      {/* ====== BASIC CONTROLS ====== */}
      {layout === "basic" && (
        <div className="flex items-center gap-2 flex-wrap text-xs shrink-0">
          <label className="text-fob-text-dim">Rate:</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
            value={sampleRate} onChange={e => setSampleRate(Number(e.target.value))} disabled={running}>
            {SAMPLE_RATES_DSO.map(r => <option key={r.hz} value={r.hz}>{r.label}</option>)}
          </select>
          <label className="text-fob-text-dim">Window:</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
            value={timebaseMs} onChange={e => setTimebaseMs(Number(e.target.value))}>
            {TIMEBASE_OPTIONS.map(t => <option key={t.ms} value={t.ms}>{t.label}</option>)}
          </select>
          <label className="text-fob-text-dim">Range:</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
            value={voltRange} onChange={e => setVoltRange(Number(e.target.value))} disabled={running}>
            {VOLT_RANGES.map(r => <option key={r.vpp} value={r.vpp}>{r.label}</option>)}
          </select>
          <label className="text-fob-text-dim">CH1 off:</label>
          <button onClick={() => setCh1Offset(Math.max(-voltRange * 500, ch1Offset - 10))}
            className="px-1 rounded bg-fob-surface border border-fob-border hover:bg-fob-border">-</button>
          <input type="number" className="w-14 bg-fob-surface border border-fob-border rounded px-1 py-0.5"
            value={ch1Offset} onChange={e => setCh1Offset(Number(e.target.value))} />
          <button onClick={() => setCh1Offset(Math.min(voltRange * 500, ch1Offset + 10))}
            className="px-1 rounded bg-fob-surface border border-fob-border hover:bg-fob-border">+</button>
          <label className="text-fob-text-dim">CH2:</label>
          <input type="checkbox" checked={showCh2} onChange={e => setShowCh2(e.target.checked)} disabled={running} />
          <label className="text-fob-text-dim">Cal:</label>
          <select className="bg-fob-surface border border-fob-border rounded px-1 py-0.5"
            value={testSignal} onChange={e => setTestSignalFreq(e.target.value)} disabled={!connected}>
            {Object.keys(TEST_SIGNAL_FREQS).map(f => (
              <option key={f} value={f}>{f === "off" ? "Off" : f}</option>
            ))}
          </select>
          <button onClick={applyTestSignal} disabled={!connected || isApplying}
            className="px-2 py-0.5 rounded bg-fob-orange hover:bg-fob-orange/80 disabled:opacity-40 text-xs font-bold">
            {isApplying ? "Applying…" : "Apply"}
          </button>
        </div>
      )}
    </div>
  );
}
