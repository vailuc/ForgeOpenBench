import type uPlot from "uplot";
import type { TraceSnapshot } from "./scopeTypes";

export const MAX_PHOSPHOR_TRACES = 8;

/* ── Trigger level line ─────────────────────────────────────────────── */
export interface TriggerLineDeps {
  getLevel: () => number;
  getSource: () => "ch1" | "ch2" | "ext" | "acline";
  getVdiv: () => number;
  getPos: (source: "ch1" | "ch2" | "ext" | "acline") => number;
  viewMode: string;
}
export function makeDrawTriggerLine(deps: TriggerLineDeps): (u: uPlot) => void {
  return (u) => {
    if (deps.viewMode !== "time") return;
    const level = deps.getLevel();
    const posOff = deps.getPos(deps.getSource()) * deps.getVdiv();
    const ctx = u.ctx;
    const plotTop = u.bbox.top;
    const plotH = u.bbox.height;
    const plotLeft = u.bbox.left;
    const plotRight = plotLeft + u.bbox.width;
    const yRange = deps.getVdiv() * 10;
    const vmin = -yRange / 2 + posOff;
    const vmax = yRange / 2 + posOff;
    const yScale = plotH / (vmax - vmin);
    const yOfs = plotTop + plotH;
    const y = yOfs - (level - vmin) * yScale;
    ctx.save();
    ctx.strokeStyle = "#FF00FF";
    ctx.lineWidth = 2;
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
}

/* ── Digital phosphor (fading trace echoes + rolling lock) ────────── */
export interface PhosphorDeps {
  tracesRef: { current: TraceSnapshot[] };
  enabledRef: { current: boolean };
  rollingTriggerTimesRef: { current: number[] };
  rollingLockedSnapRef: { current: TraceSnapshot | null };
}
export function makeDrawPhosphor(deps: PhosphorDeps): (u: uPlot) => void {
  return (u) => {
    const t0 = performance.now();
    const ctx = u.ctx;
    const traces = deps.tracesRef.current;
    if (deps.enabledRef.current && traces.length > 0) {
      const n = traces.length;
      for (let t = 0; t < n - 1; t++) {
        const snap = traces[t];
        const age = n - 1 - t;
        const opacity = Math.max(0, 1 - age / MAX_PHOSPHOR_TRACES) * 0.35;
        if (opacity <= 0) continue;
        const len = snap.ys1.length;
        const drawStep = Math.max(1, Math.floor(len / 2000));
        let xFor: (i: number) => number | null;
        if (snap.mode === "time") {
          const xMin = u.scales.x.min ?? 0;
          const xMax = u.scales.x.max ?? 0;
          const triggerX = xMin + (xMax - xMin) * 0.25;
          const toff = snap.triggerOffset ?? 0;
          const sdt = snap.dt ?? 1e-6;
          xFor = (i: number) => u.valToPos(triggerX + (i - toff) * sdt, "x", true);
        } else {
          if (!snap.xs) continue;
          xFor = (i: number) => u.valToPos(snap.xs[i], "x", true);
        }
        ctx.beginPath();
        ctx.strokeStyle = `rgba(160,90,20,${opacity})`;
        ctx.lineWidth = 1;
        let first = true;
        for (let i = 0; i < len; i += drawStep) {
          const x = xFor(i);
          const y = u.valToPos(snap.ys1[i], "y", true);
          if (x == null || y == null) continue;
          if (first) { ctx.moveTo(x, y); first = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = `rgba(30,60,140,${opacity})`;
        ctx.lineWidth = 1;
        first = true;
        for (let i = 0; i < len; i += drawStep) {
          const x = xFor(i);
          const y = u.valToPos(snap.ys2[i], "y", true);
          if (x == null || y == null) continue;
          if (first) { ctx.moveTo(x, y); first = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
      }
    }
    // Rolling-mode smart lock overlay
    const lockSnap = deps.rollingLockedSnapRef.current;
    if (lockSnap && lockSnap.mode === "time" && lockSnap.xs) {
      const lastTrigger = deps.rollingTriggerTimesRef.current[deps.rollingTriggerTimesRef.current.length - 1];
      const age = performance.now() - (lastTrigger ?? 0);
      if (age < 3000) {
        const xForLock = (i: number) => u.valToPos(lockSnap.xs[i], "x", true);
        ctx.beginPath();
        ctx.strokeStyle = "rgba(245, 158, 11, 0.85)";
        ctx.lineWidth = 1.5;
        let first = true;
        for (let i = 0; i < lockSnap.ys1.length; i++) {
          const x = xForLock(i);
          const y = u.valToPos(lockSnap.ys1[i], "y", true);
          if (x == null || y == null) continue;
          if (first) { ctx.moveTo(x, y); first = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = "rgba(96, 165, 250, 0.85)";
        ctx.lineWidth = 1.5;
        first = true;
        for (let i = 0; i < lockSnap.ys2.length; i++) {
          const x = xForLock(i);
          const y = u.valToPos(lockSnap.ys2[i], "y", true);
          if (x == null || y == null) continue;
          if (first) { ctx.moveTo(x, y); first = false; }
          else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
      }
    }
    const elapsed = performance.now() - t0;
    if (elapsed > 50) {
      // eslint-disable-next-line no-console
      console.log(`[DSO] drawPhosphor slow: ${elapsed.toFixed(1)}ms (${traces.length} traces)`);
    }
  };
}

/* ── Reference waveform ─────────────────────────────────────────────── */
export interface ReferenceDeps {
  snapRef: { current: TraceSnapshot | null };
}
export function makeDrawReference(deps: ReferenceDeps): (u: uPlot) => void {
  return (u) => {
    const snap = deps.snapRef.current;
    if (!snap || snap.mode !== "time" || !snap.xs) return;
    const ctx = u.ctx;
    const len = snap.ys1.length;
    if (len < 2) return;
    const drawStep = Math.max(1, Math.floor(len / 2000));
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(245, 158, 11, 0.25)";
    ctx.lineWidth = 1;
    let first = true;
    for (let i = 0; i < len; i += drawStep) {
      const x = u.valToPos(snap.xs[i], "x", true);
      const y = u.valToPos(snap.ys1[i], "y", true);
      if (x == null || y == null) continue;
      if (first) { ctx.moveTo(x, y); first = false; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(96, 165, 250, 0.25)";
    ctx.lineWidth = 1;
    first = true;
    for (let i = 0; i < len; i += drawStep) {
      const x = u.valToPos(snap.xs[i], "x", true);
      const y = u.valToPos(snap.ys2[i], "y", true);
      if (x == null || y == null) continue;
      if (first) { ctx.moveTo(x, y); first = false; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    ctx.restore();
  };
}

/* ── Cursors ────────────────────────────────────────────────────────── */
export interface CursorDeps {
  cursorARef: { current: { t: number; v: number } | null };
  cursorBRef: { current: { t: number; v: number } | null };
}
export function makeDrawCursors(deps: CursorDeps): (u: uPlot) => void {
  return (u) => {
    const a = deps.cursorARef.current;
    const b = deps.cursorBRef.current;
    if (!a && !b) return;
    const ctx = u.ctx;
    const plotLeft = u.bbox.left;
    const plotRight = plotLeft + u.bbox.width;
    const plotTop = u.bbox.top;
    const plotBottom = plotTop + u.bbox.height;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (a) {
      const x = u.valToPos(a.t, "x", true);
      const y = u.valToPos(a.v, "y", true);
      if (x != null) {
        ctx.strokeStyle = "#FFD700";
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }
      if (y != null) {
        ctx.strokeStyle = "#FFD700";
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
      }
      if (x != null && y != null) {
        ctx.fillStyle = "#FFD700";
        ctx.font = "10px monospace";
        ctx.fillText("A", x + 2, y - 4);
      }
    }
    if (b) {
      const x = u.valToPos(b.t, "x", true);
      const y = u.valToPos(b.v, "y", true);
      if (x != null) {
        ctx.strokeStyle = "#00FFFF";
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }
      if (y != null) {
        ctx.strokeStyle = "#00FFFF";
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
      }
      if (x != null && y != null) {
        ctx.fillStyle = "#00FFFF";
        ctx.font = "10px monospace";
        ctx.fillText("B", x + 2, y - 4);
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  };
}

/* ── Overview zoom box ──────────────────────────────────────────────── */
export function makeDrawZoomBox(
  mainPlotRef: { current: uPlot | null }
): (u: uPlot) => void {
  return (u) => {
    const main = mainPlotRef.current;
    if (!main) return;
    const xMin = main.scales.x.min ?? 0;
    const xMax = main.scales.x.max ?? 0;
    const left = u.valToPos(xMin, "x", true);
    const right = u.valToPos(xMax, "x", true);
    if (left == null || right == null) return;
    const plotTop = u.bbox.top;
    const plotBottom = plotTop + u.bbox.height;
    const ctx = u.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(245, 158, 11, 0.15)";
    ctx.fillRect(left, plotTop, right - left, plotBottom - plotTop);
    ctx.strokeStyle = "rgba(245, 158, 11, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(left, plotTop, right - left, plotBottom - plotTop);
    ctx.restore();
  };
}
