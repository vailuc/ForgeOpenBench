import type uPlot from "uplot";
import type { TraceSnapshot, MathState, HorizontalState, TriggerState, VerticalState } from "./scopeTypes";
import { fftMagnitude } from "./fftEngine";
import { MAX_PHOSPHOR_TRACES } from "./canvasOverlays";

export interface RenderCtx {
  plotRef: { current: uPlot | null };
  overviewPlotRef: { current: uPlot | null };
  viewMode: "time" | "fft" | "xy";
  sampleRateRef: { current: number };
  mathRef: { current: MathState };
  phosphorEnabledRef: { current: boolean };
  horizontalRef: { current: HorizontalState };
  triggerRef: { current: TriggerState };
  ch1VerticalRef: { current: VerticalState };
  ch2VerticalRef: { current: VerticalState };
  windowMs: number;
  // Mutable output refs
  phosphorTracesRef: { current: TraceSnapshot[] };
  plotThrottleRef: { current: number };
  forceTriggerRef: { current: ((c1: number[], c2: number[]) => void) | null };
  chunkTimesRef: { current: number[] };
  renderCountRef: { current: number };
  renderRateT0Ref: { current: number };
}

export function findTriggerIndex(buf: number[], trigger: TriggerState, sampleRate: number): number {
  if (buf.length < 100) return -1;
  const level = trigger.level;
  const slope = trigger.slope;
  const sr = sampleRate || 4_000_000;
  const windowSamples = Math.max(500, Math.ceil(sr * 0.001));
  const checkStart = Math.max(0, buf.length - windowSamples);
  for (let i = checkStart + 1; i < buf.length; i++) {
    const prev = buf[i - 1], curr = buf[i];
    if (slope === "rise" && prev <= level && curr > level) return i;
    if (slope === "fall" && prev >= level && curr < level) return i;
    if (slope === "both" && ((prev <= level && curr > level) || (prev >= level && curr < level))) return i;
  }
  return -1;
}

export function renderNow(
  ctx: RenderCtx,
  ch1: number[],
  ch2: number[],
  nowPerf: number,
  opts?: { phosphorOnly?: boolean }
): void {
  const force = () => renderNow(ctx, ch1, ch2, nowPerf);
  ctx.forceTriggerRef.current = force;
  ctx.plotThrottleRef.current = nowPerf;
  const plot = ctx.plotRef.current;
  if (!plot) return;
  const renderT0 = performance.now();
  const lastChunkT = ctx.chunkTimesRef.current.length > 0 ? ctx.chunkTimesRef.current[ctx.chunkTimesRef.current.length - 1] : renderT0;
  const e2eLatency = renderT0 - lastChunkT;
  const n = ch1.length;
  const width = plot.width ?? 1000;
  const target = Math.max(1000, width * 2);
  const vm = ctx.viewMode;

  if (vm === "fft") {
    const src = ctx.mathRef.current.sourceA === "ch2" ? ch2 : ch1;
    if (src.length < 16) return;
    const { freqs, mags } = fftMagnitude(src, ctx.sampleRateRef.current);
    const fn = freqs.length;
    const fArr = new Float64Array(fn);
    const mArr = new Float64Array(fn);
    for (let i = 0; i < fn; i++) { fArr[i] = freqs[i]; mArr[i] = mags[i]; }
    plot.setData([fArr, mArr, new Float64Array(fn), new Float64Array(fn)]);
    return;
  }

  if (vm === "xy") {
    const a = ctx.mathRef.current.sourceA === "ch2" ? ch2 : ch1;
    const b = ctx.mathRef.current.sourceB === "ch2" ? ch2 : ch1;
    const len = Math.min(a.length, b.length);
    if (len < 2) return;
    const xs = new Float64Array(len);
    const ys = new Float64Array(len);
    for (let i = 0; i < len; i++) { xs[i] = a[i]; ys[i] = b[i]; }
    plot.setData([xs, ys, new Float64Array(len), new Float64Array(len)]);
    if (ctx.phosphorEnabledRef.current) {
      const snap: TraceSnapshot = {
        mode: "xy",
        xs: new Float64Array(a.slice(0, len)),
        ys1: new Float64Array(b.slice(0, len)),
        ys2: new Float64Array(len),
      };
      ctx.phosphorTracesRef.current.push(snap);
      if (ctx.phosphorTracesRef.current.length > MAX_PHOSPHOR_TRACES) {
        ctx.phosphorTracesRef.current.shift();
      }
    }
    return;
  }

  // time mode
  const dt = 1 / (ctx.sampleRateRef.current || 4_000_000);
  const isPeak = ctx.horizontalRef.current.acquireMode === "peak";
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

  const doMath = ctx.mathRef.current.enabled && ctx.mathRef.current.op !== "fft" && ctx.mathRef.current.op !== "xy";
  let mathArr: number[] = [];
  if (doMath) {
    const a = ctx.mathRef.current.sourceA === "ch2" ? r2 : r1;
    const b = ctx.mathRef.current.sourceB === "ch2" ? r2 : r1;
    mathArr = new Array(rn).fill(0);
    for (let i = 0; i < rn; i++) {
      const av = a[i] ?? 0, bv = b[i] ?? 0;
      const op = ctx.mathRef.current.op;
      if (op === "add") mathArr[i] = av + bv;
      else if (op === "sub") mathArr[i] = av - bv;
      else if (op === "mul") mathArr[i] = av * bv;
      else if (op === "div") mathArr[i] = bv !== 0 ? av / bv : 0;
    }
  } else {
    mathArr = new Array(rn).fill(0);
  }

  const tSrc = ctx.triggerRef.current.source === "ch2" ? r2 : r1;
  const sr = ctx.sampleRateRef.current || 4_000_000;
  const windowSamples = Math.max(100, Math.ceil(ctx.windowMs / 1000 * sr));
  const tIdx = findTriggerIndex(tSrc, ctx.triggerRef.current, ctx.sampleRateRef.current, ctx.windowMs);
  const alignTrigger = tIdx >= 0 && rn > windowSamples;
  let s1 = r1, s2 = r2, sM = mathArr;
  let startIdx = 0;
  if (alignTrigger) {
    const preTrigger = Math.floor(windowSamples * 0.25);
    const postTrigger = windowSamples - preTrigger;
    startIdx = Math.max(0, tIdx - preTrigger);
    const endIdx = Math.min(rn, tIdx + postTrigger);
    s1 = r1.slice(startIdx, endIdx);
    s2 = r2.slice(startIdx, endIdx);
    sM = mathArr.slice(startIdx, endIdx);
  } else if (rn > windowSamples) {
    // No trigger found: show the latest data instead of the oldest
    startIdx = rn - windowSamples;
    s1 = r1.slice(startIdx);
    s2 = r2.slice(startIdx);
    sM = mathArr.slice(startIdx);
  }
  const sn = s1.length;

  // Phosphor capture
  if (ctx.phosphorEnabledRef.current && sn > 0) {
    const snap: TraceSnapshot = {
      mode: "time",
      ys1: new Float64Array(s1),
      ys2: new Float64Array(s2),
      triggerOffset: alignTrigger ? Math.max(0, tIdx - startIdx) : Math.floor(sn * 0.25),
      dt,
    };
    ctx.phosphorTracesRef.current.push(snap);
    if (ctx.phosphorTracesRef.current.length > MAX_PHOSPHOR_TRACES) {
      ctx.phosphorTracesRef.current.shift();
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
  let xs: Float64Array, ys1Arr: Float64Array, ys2Arr: Float64Array, ysMArr: Float64Array;
  if (!doDecimate) {
    xs = Float64Array.from({ length: sn }, (_, i) => (startIdx + i) * dt);
    ys1Arr = new Float64Array(s1); ys2Arr = new Float64Array(s2); ysMArr = new Float64Array(sM);
    plot.setData([xs, ys1Arr, ys2Arr, ysMArr]);
  } else {
    xs = new Float64Array(m); ys1Arr = new Float64Array(m); ys2Arr = new Float64Array(m); ysMArr = new Float64Array(m);
    for (let i = 0, j = 0; i < sn; i += step, j++) {
      xs[j] = (startIdx + i) * dt; ys1Arr[j] = s1[i]; ys2Arr[j] = s2[i]; ysMArr[j] = sM[i];
    }
    plot.setData([xs, ys1Arr, ys2Arr, ysMArr]);
  }
  // Overview
  const ov = ctx.overviewPlotRef.current;
  if (ov) {
    const xsOv = Float64Array.from({ length: rn }, (_, i) => (startIdx + i) * dt);
    ov.setData([xsOv, new Float64Array(r1), new Float64Array(r2), new Float64Array(mathArr)]);
  }
  // Force scale during acquisition
  const posOffset = (ctx.triggerRef.current.source === "ch2"
    ? ctx.ch2VerticalRef.current.position * ctx.ch2VerticalRef.current.vDiv
    : ctx.ch1VerticalRef.current.position * ctx.ch1VerticalRef.current.vDiv);
  const yRange = ctx.ch1VerticalRef.current.vDiv * 10;
  const yMin = -yRange / 2 + posOffset;
  const yMax = yRange / 2 + posOffset;
  const dataMin = sn > 0 ? startIdx * dt : 0;
  const dataMax = sn > 0 ? (startIdx + (m - 1) * step) * dt : 0;
  const range = dataMax - dataMin;
  const delay = (ctx.horizontalRef.current.position / 100) * range;
  plot.setScale('x', { min: dataMin + delay, max: dataMax + delay });
  plot.setScale('y', { min: yMin, max: yMax });

  // Render-rate diagnostics
  ctx.renderCountRef.current++;
  const rrNow = performance.now();
  if (ctx.renderRateT0Ref.current === 0) ctx.renderRateT0Ref.current = rrNow;
  if (rrNow - ctx.renderRateT0Ref.current >= 1000) {
    // eslint-disable-next-line no-console
    console.log(`[DSO] render rate: ${ctx.renderCountRef.current}/s`);
    ctx.renderCountRef.current = 0;
    ctx.renderRateT0Ref.current = rrNow;
  }

  const renderElapsed = performance.now() - renderT0;
  if (renderElapsed > 100) {
    // eslint-disable-next-line no-console
    console.log(`[DSO] renderNow slow: ${renderElapsed.toFixed(1)}ms (sn=${sn}, doDecimate=${doDecimate})`);
  }
  if (e2eLatency > 200) {
    // eslint-disable-next-line no-console
    console.log(`[DSO] e2e latency: ${e2eLatency.toFixed(1)}ms (render=${renderElapsed.toFixed(1)}ms)`);
  }
}
