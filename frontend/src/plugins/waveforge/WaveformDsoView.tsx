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
import { MeasurementsPanel } from "./MeasurementsPanel";
import { CursorsPanel } from "./CursorsPanel";
import type { Measurements, VerticalState, HorizontalState, TriggerState, MathState, MeasurementKey, TraceSnapshot, ScopePreset, Cursor } from "./scopeTypes";
import { SAMPLE_RATES_DSO, VDIV_STEPS, SDIV_STEPS, formatSDiv, vDivToVpp, sDivToWindowMs } from "./scopeConstants";
import { calcMeasurements, autoset } from "./waveformMath";
import {
  makeDrawTriggerLine, makeDrawPhosphor, makeDrawReference,
  makeDrawCursors, makeDrawZoomBox, makeDrawFftPeaks,
} from "./canvasOverlays";
import { renderNow } from "./renderEngine";
import { handleAcquireMode } from "./acquireModes";
import { timeAxisValues, freqAxisValues, makeVoltAxisValues } from "./axisFormatters";
import {
  notifyStarted, notifyStopped, notifySingle, notifyRolling, notifyAveraging,
  notifyConnected, notifyDisconnected, notifyReferenceSaved, notifyReferenceCleared,
  notifyAutoSetDone, notifyAutoSetFailed, notifyPresetSaved, notifyPresetLoaded,
  notifyPresetsImported, notifyPresetDeleted, notifyError,
} from "./scopeToasts";
import { loadPresets, savePresets, createPreset, uniquePresetName, exportPresets, importPresets } from "./scopePresets";
import { exportTraceCsv, exportPlotPng } from "./scopeExport";

/* ── Props ─────────────────────────────────────────────────────────── */
interface Props {
  transport: UsbTransport;
  isActive: boolean;
  connected: boolean;
  resetting?: boolean;
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
export function WaveformDsoView({ transport, isActive, connected, resetting }: Props) {
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
  const wasConnectedRef = useRef(connected);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => {
    if (connected && !wasConnectedRef.current) notifyConnected();
    if (!connected && wasConnectedRef.current) notifyDisconnected();
    wasConnectedRef.current = connected;
  }, [connected]);

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
      if (mode !== "rolling") { setAcquireMode("rolling"); notifyRolling(); }
    } else if (horizontal.acquireMode === "average") {
      if (mode !== "averaging") { setAcquireMode("averaging"); notifyAveraging(); }
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
  const [phosphorIntensity, setPhosphorIntensity] = useState(persisted?.phosphorIntensity ?? 0.35);
  const phosphorIntensityRef = useRef(phosphorIntensity);
  const [phosphorTracesCount, setPhosphorTracesCount] = useState(persisted?.phosphorTracesCount ?? 8);
  const phosphorTracesCountRef = useRef(phosphorTracesCount);
  // FFT peak markers
  const [fftPeaksEnabled, setFftPeaksEnabled] = useState(false);
  const fftPeaksEnabledRef = useRef(fftPeaksEnabled);
  useEffect(() => { phosphorEnabledRef.current = phosphorEnabled; }, [phosphorEnabled]);
  useEffect(() => { phosphorIntensityRef.current = phosphorIntensity; }, [phosphorIntensity]);
  useEffect(() => { phosphorTracesCountRef.current = phosphorTracesCount; }, [phosphorTracesCount]);
  useEffect(() => { fftPeaksEnabledRef.current = fftPeaksEnabled; }, [fftPeaksEnabled]);
  // Trace-echo phosphor: ring buffer of recent aligned traces
  const phosphorTraces = useRef<TraceSnapshot[]>([]);
  const forceTriggerRef = useRef<(() => void) | null>(null);
  // Rolling-mode smart lock: auto-capture stable triggered frame
  const rollingTriggerTimes = useRef<number[]>([]);
  const rollingLockedSnap = useRef<TraceSnapshot | null>(null);

  // Derived view mode
  const viewMode = math.enabled && math.op === "fft" ? "fft" : math.enabled && math.op === "xy" ? "xy" : "time";

  // Sample rate (shared)
  const [sampleRate, setSampleRate] = useState(persisted?.sampleRate ?? 4_000_000);

  // Named scope presets
  const [presets, setPresets] = useState<ScopePreset[]>(() => loadPresets());
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

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
  const [ch1MeasKeys, setCh1MeasKeys] = useState<MeasurementKey[]>(["vpp", "freq", "vrms"]);
  const [ch2MeasKeys, setCh2MeasKeys] = useState<MeasurementKey[]>(["vpp", "freq", "vrms"]);

  // Cursors
  const [cursorA, setCursorA] = useState<Cursor | null>(null);
  const [cursorB, setCursorB] = useState<Cursor | null>(null);
  const [cursorsEnabled, setCursorsEnabled] = useState(false);
  const cursorARef = useRef(cursorA);
  useEffect(() => { cursorARef.current = cursorA; }, [cursorA]);
  const cursorBRef = useRef(cursorB);
  useEffect(() => { cursorBRef.current = cursorB; }, [cursorB]);
  const cursorsEnabledRef = useRef(cursorsEnabled);
  useEffect(() => { cursorsEnabledRef.current = cursorsEnabled; }, [cursorsEnabled]);

  // Reference waveform snapshot
  const referenceSnapRef = useRef<TraceSnapshot | null>(null);
  const [hasRef, setHasRef] = useState(false);

  const measThrottleRef = useRef(0);
  const plotThrottleRef = useRef(0);

  // Trigger line drag state (ref survives across handler re-attachments)
  const isDraggingTriggerRef = useRef(false);
  const isDraggingCursorARef = useRef(false);
  const isDraggingCursorBRef = useRef(false);

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
  useEffect(() => {
    sampleRateRef.current = sampleRate;
    // If actively streaming, do a full stop/configure/start cycle so the backend
    // actually applies the new sample rate to the hardware. We must unregister
    // the data handler and set intentionalStopRef before calling transport.stop()
    // to avoid RPC timeouts and auto-restart races.
    if (dataOffRef.current) {
      (async () => {
        // --- soft stop (same pattern as handleStop) ---
        intentionalStopRef.current = true;
        runningRef.current = false;
        dataOffRef.current?.();
        dataOffRef.current = null;
        ch1Buf.current = [];
        ch2Buf.current = [];
        mathBuf.current = [];
        phosphorTraces.current = [];
        filtRing1.current = [];
        filtRing2.current = [];
        plotThrottleRef.current = 0;
        try { await transport.stop(); } catch { }

        // --- restart with new rate (same pattern as handleRun start) ---
        try {
          await transport.configure({
            mode: "dso",
            sample_rate_hz: sampleRate,
            sample_width: 8,
            voltage_range: vpp,
          });
          dataOffRef.current = transport.onData(pushData);
          await transport.start();
          runningRef.current = true;
          intentionalStopRef.current = false;
        } catch (e) {
          runningRef.current = false;
          if (e instanceof Error && e.message.includes("Not connected")) {
            intentionalStopRef.current = true;
          }
          const msg = e instanceof Error ? e.message : String(e);
          notifyError(`Sample rate change failed: ${msg}`);
          console.warn("[DSO] sample-rate restart failed", e);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleRate]);
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
      phosphorEnabled, phosphorIntensity, phosphorTracesCount, sampleRate,
    });
  }, [ch1Vertical, ch2Vertical, horizontal, trigger, math, phosphorEnabled, phosphorIntensity, phosphorTracesCount, sampleRate]);

  // Auto-start when connected and active (skip during parent-initiated reset)
  useEffect(() => {
    if (resetting) return;
    if (connected && isActive && !runningRef.current && !pausedRef.current) {
      // Small debounce to avoid Strict Mode double-mount race
      const t = setTimeout(() => {
        if (connected && isActive && !runningRef.current && !pausedRef.current) {
          void start();
        }
      }, 100);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isActive, resetting]);

  // Build / rebuild uPlot
  const buildPlot = useCallback((container: HTMLDivElement, overviewContainer?: HTMLDivElement) => {
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null; }
    if (overviewPlotRef.current) { overviewPlotRef.current.destroy(); overviewPlotRef.current = null; }
    const W = container.offsetWidth || 600;
    const H = container.offsetHeight || 300;

    const mode = viewMode;

    const voltAxisValues = makeVoltAxisValues(vpp);

    // Canvas overlay hooks (factory functions capture latest refs)
    const drawTriggerLine = makeDrawTriggerLine({
      getLevel: () => triggerRef.current.level,
      getSource: () => triggerRef.current.source,
      getVdiv: () => ch1Vertical.vDiv,
      getPos: (src) => (src === "ch2" ? ch2Vertical.position : ch1Vertical.position),
      viewMode: mode,
    });
    const drawPhosphor = makeDrawPhosphor({
      tracesRef: phosphorTraces,
      enabledRef: phosphorEnabledRef,
      intensityRef: phosphorIntensityRef,
      maxTracesRef: phosphorTracesCountRef,
      rollingTriggerTimesRef: rollingTriggerTimes,
      rollingLockedSnapRef: rollingLockedSnap,
    });
    const drawReference = makeDrawReference({ snapRef: referenceSnapRef });
    const drawCursors = makeDrawCursors({ cursorARef, cursorBRef });
    const drawFftPeaks = makeDrawFftPeaks({ enabledRef: fftPeaksEnabledRef });

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
        hooks: { drawClear: [drawPhosphor], draw: [drawCursors, drawFftPeaks] },
      };
    } else if (mode === "xy") {
      opts = {
        width: W, height: H,
        padding: [0, 0, 0, 0],
        scales: { x: { auto: true }, y: { auto: true } },
        axes: [
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: vpp < 2 ? "mV" : "V", values: voltAxisValues },
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: vpp < 2 ? "mV" : "V", values: voltAxisValues },
        ],
        series: [
          {},
          { stroke: "#4ADE80", width: 1.5, label: "XY", show: true },
          { stroke: "#60A5FA", width: 1.5, label: "CH2", show: false },
          { stroke: "#4ADE80", width: 1.5, label: "MATH", show: false },
        ],
        cursor: { show: true, drag: { x: false, y: false } },
        hooks: { drawClear: [drawPhosphor], draw: [drawCursors] },
      };
    } else {
      opts = {
        width: W, height: H,
        padding: [0, 0, 0, 0],
        scales: { x: { time: false } },
        axes: [
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, values: timeAxisValues },
          { stroke: "#666688", grid: { stroke: "#1A1A2E" }, label: vpp < 2 ? "mV" : "V", values: voltAxisValues },
        ],
        series: [
          {},
          { stroke: "#F59E0B", width: 1.5, label: "CH1" },
          { stroke: "#60A5FA", width: 1.5, label: "CH2", show: ch2Vertical.enabled },
          { stroke: "#4ADE80", width: 1.5, label: "MATH", show: math.enabled },
        ],
        cursor: { show: true, drag: { x: false, y: false } },
        hooks: { drawClear: [drawReference, drawPhosphor], draw: [drawTriggerLine, drawCursors] },
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
        const drawZoomBox = makeDrawZoomBox(plotRef);
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
  }, [vpp, ch1Vertical.vDiv, ch2Vertical.vDiv, ch2Vertical.enabled, math.enabled, ch1Vertical.position, ch2Vertical.position, horizontal.position, horizontal.sDiv, viewMode]);

  useEffect(() => {
    const div = plotDivRef.current;
    const odiv = overviewDivRef.current;
    if (!div) return;
    buildPlot(div, odiv ?? undefined);

    // Trigger line Y in canvas-relative coords (matches uPlot valToPos)
    const getTriggerLineY = (): number | null => {
      const plot = plotRef.current;
      if (!plot || viewMode !== "time") return null;
      const y = plot.valToPos(triggerRef.current.level, "y");
      if (y == null) return null;
      return y;
    };

    // Cursor hit detection: only the vertical cursor line is grabbable
    const getCursorHit = (mx: number, my: number): "a" | "b" | null => {
      const plot = plotRef.current;
      if (!plot || !cursorsEnabledRef.current) return null;
      const a = cursorARef.current;
      const b = cursorBRef.current;
      const plotLeft = plot.bbox.left;
      const plotRight = plotLeft + plot.bbox.width;
      const plotTop = plot.bbox.top;
      const plotBottom = plotTop + plot.bbox.height;
      const lineHit = 40;
      if (a) {
        const cx = plot.valToPos(a.x, "x");
        if (cx != null && mx >= plotLeft && mx <= plotRight && my >= plotTop && my <= plotBottom && Math.abs(mx - cx) <= lineHit) return "a";
      }
      if (b) {
        const cx = plot.valToPos(b.x, "x");
        if (cx != null && mx >= plotLeft && mx <= plotRight && my >= plotTop && my <= plotBottom && Math.abs(mx - cx) <= lineHit) return "b";
      }
      return null;
    };

    // Custom panning (click-drag), trigger drag, cursor drag, and wheel zoom
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let panStartXMin = 0, panStartXMax = 0, panStartYMin = 0, panStartYMax = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const plot = plotRef.current;
      if (!plot) return;
      const canvas = plot.ctx.canvas;
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const my = e.clientY - canvasRect.top;
      const triggerY = getTriggerLineY();
      // Check if clicking near trigger line (works even during acquisition)
      if (triggerY !== null && Math.abs(my - triggerY) <= 20) {
        isDraggingTriggerRef.current = true;
        div.style.cursor = "ns-resize";
        e.preventDefault();
        return;
      }
      // Cursor interaction (when cursors enabled)
      if (cursorsEnabledRef.current) {
        const mx = e.clientX - canvasRect.left;
        const hit = getCursorHit(mx, my);
        if (hit === "a") {
          isDraggingCursorARef.current = true;
          div.style.cursor = "move";
          e.preventDefault();
          return;
        }
        if (hit === "b") {
          isDraggingCursorBRef.current = true;
          div.style.cursor = "move";
          e.preventDefault();
          return;
        }
        const x = plot.posToVal(mx, "x");
        const y = plot.posToVal(my, "y");
        if (e.shiftKey) {
          setCursorB({ x, y });
        } else {
          setCursorA({ x, y });
        }
        plot.redraw(false, false);
        e.preventDefault();
        return;
      }
      // Otherwise, normal pan (only when not acquiring)
      const amode = acquireModeRef.current;
      if (amode === "running" || amode === "rolling" || amode === "single-armed" || amode === "averaging") return;
      e.preventDefault();
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartXMin = plot.scales.x.min ?? 0;
      panStartXMax = plot.scales.x.max ?? 0;
      panStartYMin = plot.scales.y.min ?? 0;
      panStartYMax = plot.scales.y.max ?? 0;
    };
    const onMouseMove = (e: MouseEvent) => {
      // Trigger drag (works during acquisition too)
      if (isDraggingTriggerRef.current) {
        const plot = plotRef.current;
        if (!plot) return;
        const canvas = plot.ctx.canvas;
        if (!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        const mouseY = e.clientY - canvasRect.top;
        const newLevel = plot.posToVal(mouseY, "y");
        const posOff = (triggerRef.current.source === "ch2"
          ? ch2VerticalRef.current.position * ch2VerticalRef.current.vDiv
          : ch1VerticalRef.current.position * ch1VerticalRef.current.vDiv);
        const yRange = ch1VerticalRef.current.vDiv * 10;
        const vmin = -yRange / 2 + posOff;
        const vmax = yRange / 2 + posOff;
        const clamped = Math.max(vmin, Math.min(vmax, newLevel));
        setTrigger(prev => ({ ...prev, level: clamped }));
        return;
      }
      // Cursor drag
      if (isDraggingCursorARef.current || isDraggingCursorBRef.current) {
        const plot = plotRef.current;
        if (!plot) return;
        const canvas = plot.ctx.canvas;
        if (!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        const mx = e.clientX - canvasRect.left;
        const my = e.clientY - canvasRect.top;
        const x = plot.posToVal(mx, "x");
        const y = plot.posToVal(my, "y");
        if (isDraggingCursorARef.current) setCursorA({ x, y });
        if (isDraggingCursorBRef.current) setCursorB({ x, y });
        plot.redraw(false, false);
        return;
      }
      if (!isPanning) {
        // Hover: change cursor when near trigger line or cursor
        const plot = plotRef.current;
        const triggerY = getTriggerLineY();
        let my = -9999, mx = -9999;
        if (plot) {
          const canvas = plot.ctx.canvas;
          if (canvas) {
            const canvasRect = canvas.getBoundingClientRect();
            my = e.clientY - canvasRect.top;
            mx = e.clientX - canvasRect.left;
          }
        }
        const nearTrigger = triggerY !== null && Math.abs(my - triggerY) <= 20;
        const nearCursor = mx !== -9999 && getCursorHit(mx, my) !== null;
        if (nearTrigger) {
          div.style.cursor = "ns-resize";
        } else if (nearCursor) {
          div.style.cursor = "move";
        } else {
          div.style.cursor = "";
        }
        return;
      }
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
    const onMouseUp = () => {
      isDraggingTriggerRef.current = false;
      isDraggingCursorARef.current = false;
      isDraggingCursorBRef.current = false;
      isPanning = false;
      div.style.cursor = "";
    };

    let lastWheelTime = 0;
    const onWheel = (e: WheelEvent) => {
      const amode = acquireModeRef.current;
      if (amode === "running" || amode === "rolling" || amode === "single-armed" || amode === "averaging") return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastWheelTime < 50) return; // throttle to 50ms (~20 fps max)
      lastWheelTime = now;
      const plot = plotRef.current;
      if (!plot) return;
      const factor = e.deltaY < 0 ? 0.85 : 1.15;
      const xMin = plot.scales.x.min ?? 0;
      const xMax = plot.scales.x.max ?? 0;
      const yMin = plot.scales.y.min ?? 0;
      const yMax = plot.scales.y.max ?? 0;
      // Use canvas-relative coords (same system as plot.bbox)
      const canvas = plot.ctx.canvas;
      if (!canvas) return;
      const cRect = canvas.getBoundingClientRect();
      const mx = e.clientX - cRect.left;
      const my = e.clientY - cRect.top;
      const pl = plot.bbox.left;
      const pt = plot.bbox.top;
      const pw = plot.bbox.width;
      const ph = plot.bbox.height;
      if (mx < pl || mx > pl + pw || my < pt || my > pt + ph) return;
      const fx = (mx - pl) / pw;
      const fy = (my - pt) / ph;
      let xRange = (xMax - xMin) * factor;
      let yRange = (yMax - yMin) * factor;
      // Guard against zooming in too far (min 10 µs x, min 1 mV y)
      if (xRange < 1e-5) xRange = 1e-5;
      if (yRange < 0.001) yRange = 0.001;
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

    const onDoubleClick = (e: MouseEvent) => {
      if (!cursorsEnabledRef.current) return;
      const plot = plotRef.current;
      if (!plot) return;
      const canvas = plot.ctx.canvas;
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const mx = e.clientX - canvasRect.left;
      const my = e.clientY - canvasRect.top;
      const hit = getCursorHit(mx, my);
      if (hit === "a") {
        setCursorA(null);
        plot.redraw(false, false);
      } else if (hit === "b") {
        setCursorB(null);
        plot.redraw(false, false);
      }
    };
    div.addEventListener('dblclick', onDoubleClick);

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
      div.removeEventListener('dblclick', onDoubleClick);
      odiv?.removeEventListener('mousedown', onOverviewClick);
      ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null;
      overviewPlotRef.current?.destroy(); overviewPlotRef.current = null;
    };
  }, [buildPlot]);

  // Data push handler
  const chunkTimes = useRef<number[]>([]);
  const renderCount = useRef(0);
  const renderRateT0 = useRef(0);
  const totalBytes = useRef(0);
  const dataAgeT0 = useRef(0);
  const pushData = useCallback((chunk: UsbDataChunk) => {
    const bytes = chunk.data ?? Uint8Array.from(atob(chunk.b64), c => c.charCodeAt(0));
    const gain = vpp / 256;
    const chunkT0 = performance.now();

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
    chunkTimes.current.push(chunkT0);
    if (chunkTimes.current.length > 20) chunkTimes.current.shift();

    // Data-age: compare sample-time received vs wall-time elapsed
    totalBytes.current += bytes.length;
    if (dataAgeT0.current === 0) dataAgeT0.current = performance.now();
    const wallMs = performance.now() - dataAgeT0.current;
    const sampleMs = (totalBytes.current / 2) / (chunk.rate || 4_000_000) * 1000; // samples = bytes/2 (interleaved), time = samples/rate
    if (wallMs >= 1000) {
      // eslint-disable-next-line no-console
      console.log(`[DSO] data age: received ${sampleMs.toFixed(0)}ms of sample data in ${wallMs.toFixed(0)}ms wall time (diff=${(sampleMs - wallMs).toFixed(0)}ms)`);
      totalBytes.current = 0;
      dataAgeT0.current = performance.now();
    }

    // Trigger detection helper — returns crossing index or -1
    const renderCtx = {
      plotRef, overviewPlotRef,
      viewMode: viewMode as "time" | "fft" | "xy",
      sampleRateRef, mathRef, phosphorEnabledRef,
      horizontalRef, triggerRef,
      ch1VerticalRef, ch2VerticalRef, windowMs,
      phosphorTracesRef: phosphorTraces, plotThrottleRef, forceTriggerRef,
      chunkTimesRef: chunkTimes, renderCountRef: renderCount,
      renderRateT0Ref: renderRateT0,
    };
    const sourceBuf = triggerRef.current.source === "ch2" ? ch2Buf.current : ch1Buf.current;

    handleAcquireMode({
      mode,
      sourceBuf,
      ch1Buf: ch1Buf.current,
      ch2Buf: ch2Buf.current,
      nowPerf,
      vpp,
      windowMs,
      triggerRef,
      horizontalRef,
      sampleRateRef,
      plotThrottleRef,
      triggerArmedRef,
      smartStateRef,
      smartTriggerCountRef,
      smartMissCountRef,
      rollingTriggerTimesRef: rollingTriggerTimes,
      rollingLockedSnapRef: rollingLockedSnap,
      avgAccumCountRef: avgAccumCount,
      avgBuf1Ref: avgBuf1,
      avgBuf2Ref: avgBuf2,
      phosphorTracesRef: phosphorTraces,
      renderNow: (c1, c2, opts) => renderNow(renderCtx, c1, c2, nowPerf, opts),
      setAcquireMode,
      stop,
    });
  }, [vpp, windowMs]);

  // Start / stop
  const start = useCallback(async () => {
    if (!connected || runningRef.current) return;
    // Guard against Strict Mode double-mount and parent reset races
    if (!transport.deviceInfo) {
      console.warn("[DSO] start skipped: no device connected");
      return;
    }
    // If we already have an active data handler, the backend is streaming.
    // Just resume state without re-configuring (avoids disruption on spurious usb_stopped).
    if (dataOffRef.current) {
      runningRef.current = true;
      setAcquireMode("running");
      return;
    }
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
      // If the device isn't connected, suppress auto-restart so we don't hammer the backend.
      if (e instanceof Error && e.message.includes("Not connected")) {
        intentionalStopRef.current = true;
      }
      const msg = e instanceof Error ? e.message : String(e);
      notifyError(`Start failed: ${msg}`);
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
  const handleRun = () => { notifyStarted(); void start(); };
  const handleStop = () => { notifyStopped(); void stop(true); };
  const handleSingle = () => {
    notifySingle();
    setAcquireMode("single-armed");
    void start();
  };
  const handleAutoSet = () => {
    const result = autoset(ch1Buf.current, ch2Buf.current, sampleRate, VDIV_STEPS, SDIV_STEPS);
    if (result) {
      // eslint-disable-next-line no-console
      console.log(`[DSO] Autoset: vDiv=${result.vDiv}V/div, sDiv=${formatSDiv(result.sDiv)}, trigger=${result.triggerLevel.toFixed(3)}V, source=${result.source}`);
      // Center each channel with a real signal on screen
      if (result.ch1HasSignal) setCh1Vertical(prev => ({ ...prev, vDiv: result.vDiv, position: result.ch1Position }));
      if (result.ch2HasSignal) setCh2Vertical(prev => ({ ...prev, vDiv: result.vDiv, position: result.ch2Position }));
      setHorizontal(prev => ({ ...prev, sDiv: result.sDiv, rollMode: false }));
      setTrigger(prev => ({ ...prev, level: result.triggerLevel, source: result.source }));
      // Clear phosphor ghosts so they don't mismatch the new timebase
      phosphorTraces.current = [];
      // Force a fresh render with current buffers at new settings
      if (ch1Buf.current.length > 0) {
        forceTriggerRef.current?.();
      }
      notifyAutoSetDone();
    } else {
      notifyAutoSetFailed();
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

  const handleSaveReference = () => {
    const plot = plotRef.current;
    if (!plot || !plot.data) return;
    const xs = plot.data[0] as Float64Array | number[];
    const ys1 = plot.data[1] as Float64Array | number[];
    const ys2 = plot.data[2] as Float64Array | number[];
    if (!xs || xs.length < 2) return;
    referenceSnapRef.current = {
      mode: "time",
      ys1: new Float64Array(ys1),
      ys2: new Float64Array(ys2),
      triggerOffset: 0,
      dt: 0,
      xs: new Float64Array(xs),
    };
    setHasRef(true);
    plot.redraw(false, false);
    notifyReferenceSaved();
  };

  const handleClearReference = () => {
    referenceSnapRef.current = null;
    setHasRef(false);
    plotRef.current?.redraw(false, false);
    notifyReferenceCleared();
  };

  const handleSavePreset = () => {
    const base = uniquePresetName(presets, selectedPreset || "Setup");
    const name = window.prompt("Save preset as:", base);
    if (!name) return;
    const finalName = uniquePresetName(presets, name.trim());
    const preset = createPreset(finalName, {
      ch1Vertical, ch2Vertical, horizontal, trigger, math,
      phosphorEnabled, phosphorIntensity, phosphorTracesCount, sampleRate,
    });
    const next = presets.filter(p => p.name !== finalName).concat(preset);
    setPresets(next);
    savePresets(next);
    setSelectedPreset(finalName);
    notifyPresetSaved(finalName);
  };

  const handleLoadPreset = () => {
    const preset = presets.find(p => p.name === selectedPreset);
    if (!preset) return;
    notifyPresetLoaded(preset.name);
    setCh1Vertical(preset.state.ch1Vertical);
    setCh2Vertical(preset.state.ch2Vertical);
    setHorizontal(preset.state.horizontal);
    setTrigger(preset.state.trigger);
    setMath(preset.state.math);
    setPhosphorEnabled(preset.state.phosphorEnabled);
    setPhosphorIntensity(preset.state.phosphorIntensity ?? 0.35);
    setPhosphorTracesCount(preset.state.phosphorTracesCount ?? 8);
    setSampleRate(preset.state.sampleRate);
  };

  const handleDeletePreset = () => {
    if (!selectedPreset) return;
    const next = presets.filter(p => p.name !== selectedPreset);
    setPresets(next);
    savePresets(next);
    notifyPresetDeleted(selectedPreset);
    setSelectedPreset(null);
  };

  const handleExportPresets = () => {
    const blob = new Blob([exportPresets(presets)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scope-presets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportPresets = (json: string) => {
    const imported = importPresets(json);
    if (!imported || imported.length === 0) {
      notifyError("Import failed: invalid preset file");
      return;
    }
    const next = [...presets];
    for (const p of imported) {
      const idx = next.findIndex(existing => existing.name === p.name);
      if (idx >= 0) {
        next[idx] = p;
      } else {
        next.push(p);
      }
    }
    setPresets(next);
    savePresets(next);
    notifyPresetsImported(imported.length);
  };

  const handleExportCsv = () => {
    const names = ["CH1"];
    if (ch2Vertical.enabled) names.push("CH2");
    if (math.enabled) names.push("MATH");
    exportTraceCsv(plotRef.current, names, viewMode);
  };

  const handleExportPng = () => {
    exportPlotPng(plotRef.current, `scope-${viewMode}-${Date.now()}.png`);
  };

  const setCursorAtCenter = (setCursor: (c: Cursor) => void) => {
    const plot = plotRef.current;
    if (!plot) return;
    const xMin = plot.scales.x.min ?? 0;
    const xMax = plot.scales.x.max ?? 0;
    const yMin = plot.scales.y.min ?? 0;
    const yMax = plot.scales.y.max ?? 0;
    const x = xMin + (xMax - xMin) * 0.5;
    const y = yMin + (yMax - yMin) * 0.5;
    setCursor({ x, y });
    if (!cursorsEnabled) setCursorsEnabled(true);
    plot.redraw(false, false);
  };
  const handleSetCursorA = () => setCursorAtCenter(setCursorA);
  const handleSetCursorB = () => setCursorAtCenter(setCursorB);

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
        triggerMode={trigger.mode}
        onSetTriggerMode={(mode) => setTrigger(prev => ({ ...prev, mode }))}
        onSaveRef={handleSaveReference}
        onClearRef={handleClearReference}
        hasRef={hasRef}
        sampleRateLabel={rateLabel}
        sDivLabel={formatSDiv(horizontal.sDiv)}
        connected={connected}
        presets={presets}
        selectedPreset={selectedPreset}
        onSelectPreset={setSelectedPreset}
        onSavePreset={handleSavePreset}
        onLoadPreset={handleLoadPreset}
        onDeletePreset={handleDeletePreset}
        onExportPresets={handleExportPresets}
        onImportPresets={handleImportPresets}
        onExportCsv={handleExportCsv}
        onExportPng={handleExportPng}
        onSetCursorA={handleSetCursorA}
        onSetCursorB={handleSetCursorB}
      />

      {/* Main Area: Canvas + Right Panel */}
      <div className="flex flex-1 gap-1 overflow-hidden min-h-0">
        {/* Canvas */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0 gap-1">
          <div ref={plotDivRef} className="flex-1 rounded border border-fob-border overflow-hidden bg-fob-surface min-h-0 min-w-0 select-none" />
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
            fftPeaksEnabled={fftPeaksEnabled}
            onToggleFftPeaks={setFftPeaksEnabled}
          />
          <MeasurementsPanel
            ch1Keys={ch1MeasKeys}
            ch2Keys={ch2MeasKeys}
            onCh1KeysChange={setCh1MeasKeys}
            onCh2KeysChange={setCh2MeasKeys}
          />
          <CursorsPanel
            enabled={cursorsEnabled}
            onToggle={setCursorsEnabled}
            cursorA={cursorA}
            cursorB={cursorB}
            viewMode={viewMode}
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
          {phosphorEnabled && (
            <div className="flex flex-col gap-1 border-t border-fob-border pt-1">
              <label className="flex items-center gap-1 text-[10px] text-fob-text-dim">
                Intensity
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={phosphorIntensity}
                  onChange={(e) => setPhosphorIntensity(Number(e.target.value))}
                  className="w-24 accent-fob-orange"
                />
                <span className="font-mono">{Math.round(phosphorIntensity * 100)}%</span>
              </label>
              <label className="flex items-center gap-1 text-[10px] text-fob-text-dim">
                Persistence
                <input
                  type="range"
                  min={1}
                  max={24}
                  step={1}
                  value={phosphorTracesCount}
                  onChange={(e) => setPhosphorTracesCount(Number(e.target.value))}
                  className="w-24 accent-fob-orange"
                />
                <span className="font-mono">{phosphorTracesCount}</span>
              </label>
            </div>
          )}
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
