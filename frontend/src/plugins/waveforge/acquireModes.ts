import type { TraceSnapshot, TriggerState, HorizontalState } from "./scopeTypes";

export type AcquireMode = "stopped" | "running" | "single-armed" | "single-held" | "rolling" | "averaging";

export interface AcquireCtx {
  mode: "single-armed" | "averaging" | "rolling" | "running";
  sourceBuf: number[];
  ch1Buf: number[];
  ch2Buf: number[];
  nowPerf: number;
  vpp: number;
  windowMs: number;
  // Refs
  triggerRef: { current: TriggerState };
  horizontalRef: { current: HorizontalState };
  sampleRateRef: { current: number };
  plotThrottleRef: { current: number };
  triggerArmedRef: { current: boolean };
  smartStateRef: { current: "auto" | "locked" };
  smartTriggerCountRef: { current: number };
  smartMissCountRef: { current: number };
  rollingTriggerTimesRef: { current: number[] };
  rollingLockedSnapRef: { current: TraceSnapshot | null };
  avgAccumCountRef: { current: number };
  avgBuf1Ref: { current: number[] };
  avgBuf2Ref: { current: number[] };
  phosphorTracesRef: { current: TraceSnapshot[] };
  // Callbacks
  renderNow: (ch1: number[], ch2: number[], opts?: { phosphorOnly?: boolean }) => void;
  setAcquireMode: (mode: AcquireMode) => void;
  stop: (intentional?: boolean) => void;
}

export function findTriggerIndex(buf: number[], trigger: TriggerState, sampleRate: number, windowMs: number): number {
  if (buf.length < 100) return -1;
  const level = trigger.level;
  const slope = trigger.slope;
  const sr = sampleRate || 4_000_000;
  const windowSamples = Math.max(100, Math.ceil(windowMs / 1000 * sr));
  const checkStart = Math.max(0, buf.length - windowSamples);
  for (let i = checkStart + 1; i < buf.length; i++) {
    const prev = buf[i - 1], curr = buf[i];
    if (slope === "rise" && prev <= level && curr > level) return i;
    if (slope === "fall" && prev >= level && curr < level) return i;
    if (slope === "both" && ((prev <= level && curr > level) || (prev >= level && curr < level))) return i;
  }
  return -1;
}

export function detectTrigger(buf: number[], trigger: TriggerState, sampleRate: number, windowMs: number): boolean {
  return findTriggerIndex(buf, trigger, sampleRate, windowMs) >= 0;
}

export function findTriggerTime(buf: number[], trigger: TriggerState, sampleRate: number, windowMs: number): number {
  const tIdx = findTriggerIndex(buf, trigger, sampleRate, windowMs);
  if (tIdx < 0) return -1;
  const dt = 1 / (sampleRate || 4_000_000);
  const prev = buf[tIdx - 1];
  const curr = buf[tIdx];
  const level = trigger.level;
  const fraction = curr !== prev ? (level - prev) / (curr - prev) : 0;
  return (tIdx - 1 + fraction) * dt;
}

export function handleAcquireMode(ctx: AcquireCtx): void {
  if (ctx.mode === "single-armed") {
    if (detectTrigger(ctx.sourceBuf, ctx.triggerRef.current, ctx.sampleRateRef.current, ctx.windowMs)) {
      ctx.setAcquireMode("single-held");
      ctx.renderNow(ctx.ch1Buf, ctx.ch2Buf);
      void ctx.stop(true);
    }
    return;
  }

  if (ctx.mode === "averaging") {
    if (detectTrigger(ctx.sourceBuf, ctx.triggerRef.current, ctx.sampleRateRef.current, ctx.windowMs)) {
      const n = ctx.ch1Buf.length;
      if (ctx.avgAccumCountRef.current === 0) {
        ctx.avgBuf1Ref.current = new Array(n).fill(0);
        ctx.avgBuf2Ref.current = new Array(n).fill(0);
      }
      for (let i = 0; i < n; i++) {
        ctx.avgBuf1Ref.current[i] += ctx.ch1Buf[i];
        ctx.avgBuf2Ref.current[i] += ctx.ch2Buf[i];
      }
      ctx.avgAccumCountRef.current++;
      const targetCount = ctx.horizontalRef.current.averageCount;
      if (ctx.avgAccumCountRef.current >= targetCount) {
        const divisor = ctx.avgAccumCountRef.current;
        const avg1 = ctx.avgBuf1Ref.current.map(v => v / divisor);
        const avg2 = ctx.avgBuf2Ref.current.map(v => v / divisor);
        ctx.renderNow(avg1, avg2);
        ctx.avgAccumCountRef.current = 0;
        ctx.avgBuf1Ref.current = [];
        ctx.avgBuf2Ref.current = [];
      }
    }
    return;
  }

  if (ctx.mode === "rolling") {
    const tIdx = findTriggerIndex(ctx.sourceBuf, ctx.triggerRef.current, ctx.sampleRateRef.current, ctx.windowMs);
    if (tIdx >= 0) {
      ctx.rollingTriggerTimesRef.current.push(performance.now());
      if (ctx.rollingTriggerTimesRef.current.length > 10) ctx.rollingTriggerTimesRef.current.shift();
      const times = ctx.rollingTriggerTimesRef.current;
      if (times.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const max = Math.max(...intervals);
        const min = Math.min(...intervals);
        if (mean > 0 && (max - min) / mean < 0.30) {
          const sr = ctx.sampleRateRef.current || 4_000_000;
          const dt = 1 / sr;
          const windowSamples = Math.max(100, Math.ceil(ctx.windowMs / 1000 * sr));
          const preTrigger = Math.floor(windowSamples * 0.25);
          const postTrigger = windowSamples - preTrigger;
          const sIdx = Math.max(0, tIdx - preTrigger);
          const eIdx = Math.min(ctx.ch1Buf.length, tIdx + postTrigger);
          const s1 = ctx.ch1Buf.slice(sIdx, eIdx);
          const s2 = ctx.ch2Buf.slice(sIdx, eIdx);
          const xs = new Float64Array(s1.length);
          for (let i = 0; i < s1.length; i++) xs[i] = (sIdx + i) * dt;
          ctx.rollingLockedSnapRef.current = {
            mode: "time",
            xs,
            ys1: new Float64Array(s1),
            ys2: new Float64Array(s2),
            triggerOffset: Math.max(0, tIdx - sIdx),
            dt,
          };
        }
      }
    }
    if (ctx.rollingTriggerTimesRef.current.length > 0) {
      const lastTrigger = ctx.rollingTriggerTimesRef.current[ctx.rollingTriggerTimesRef.current.length - 1];
      if (performance.now() - lastTrigger > 2000) {
        ctx.rollingTriggerTimesRef.current = [];
        ctx.rollingLockedSnapRef.current = null;
      }
    }
    if (ctx.nowPerf - ctx.plotThrottleRef.current > 33) {
      ctx.renderNow(ctx.ch1Buf, ctx.ch2Buf);
    } else if (ctx.nowPerf - ctx.plotThrottleRef.current > 500) {
      // eslint-disable-next-line no-console
      console.log(`[DSO] rolling render skipped: throttle=${(ctx.nowPerf - ctx.plotThrottleRef.current).toFixed(0)}ms`);
    }
    return;
  }

  // mode === "running"
  if (ctx.nowPerf - ctx.plotThrottleRef.current > 33) {
    const tmode = ctx.triggerRef.current.mode;
    if (tmode === "auto") {
      ctx.renderNow(ctx.ch1Buf, ctx.ch2Buf);
      ctx.triggerArmedRef.current = true;
    } else if (tmode === "normal") {
      const triggered = detectTrigger(ctx.sourceBuf, ctx.triggerRef.current, ctx.sampleRateRef.current, ctx.windowMs);
      if (triggered && ctx.triggerArmedRef.current) {
        ctx.renderNow(ctx.ch1Buf, ctx.ch2Buf);
        ctx.triggerArmedRef.current = false;
      }
      if (!ctx.triggerArmedRef.current && ctx.sourceBuf.length > 0) {
        const last = ctx.sourceBuf[ctx.sourceBuf.length - 1];
        const level = ctx.triggerRef.current.level;
        const slope = ctx.triggerRef.current.slope;
        const margin = ctx.vpp * 0.05;
        if (slope === "rise" && last < level - margin) ctx.triggerArmedRef.current = true;
        if (slope === "fall" && last > level + margin) ctx.triggerArmedRef.current = true;
        if (slope === "both" && (last < level - margin || last > level + margin)) ctx.triggerArmedRef.current = true;
      }
    } else if (tmode === "smart") {
      const triggered = detectTrigger(ctx.sourceBuf, ctx.triggerRef.current, ctx.sampleRateRef.current, ctx.windowMs);
      if (ctx.smartStateRef.current === "auto") {
        ctx.renderNow(ctx.ch1Buf, ctx.ch2Buf);
        if (triggered) {
          ctx.smartTriggerCountRef.current++;
          if (ctx.smartTriggerCountRef.current > 6) {
            ctx.smartStateRef.current = "locked";
            ctx.smartMissCountRef.current = 0;
            ctx.phosphorTracesRef.current = [];
          }
        } else {
          ctx.smartTriggerCountRef.current = 0;
        }
      } else {
        if (triggered) {
          ctx.renderNow(ctx.ch1Buf, ctx.ch2Buf);
          ctx.smartMissCountRef.current = 0;
        } else {
          ctx.smartMissCountRef.current++;
        }
        if (ctx.smartMissCountRef.current > 10) {
          ctx.smartStateRef.current = "auto";
          ctx.smartTriggerCountRef.current = 0;
          ctx.smartMissCountRef.current = 0;
          ctx.phosphorTracesRef.current = [];
        }
      }
    }
  }
}
