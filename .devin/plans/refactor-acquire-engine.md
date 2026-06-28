# Refactor Plan: Acquire Engine Extraction (Approach B)

## Goal
Shrink `WaveformDsoView.tsx` from 1750 lines to ~900 lines by extracting separable concerns into focused modules. The component becomes a thin orchestrator; heavy logic moves to testable pure/helper modules and an engine module.

## Success Criteria (Verifiable)
1. `WaveformDsoView.tsx` ≤ 900 lines after refactor
2. `npx tsc --noEmit` passes with zero errors
3. No behavioral changes — all existing modes (running, single-shot, averaging, rolling, stopped) and features (trigger drag, zoom, pan, phosphor, cursors, reference, FFT, XY, math, measurements) work identically
4. New modules have no implicit dependencies on React render cycle (refs are fine, no `useState`/`useEffect`)

---

## Step 1: Extract Pure Helpers (zero risk)

### New file: `waveformMath.ts`
Contents:
- `calcMeasurements(buf, rate)` — existing function, unchanged
- `signalVariance(buf)` — existing helper, unchanged
- `findNearestStep(target, steps)` — existing helper, unchanged
- `autoset(ch1, ch2, rate, vDivSteps, sDivSteps)` — existing function, unchanged

### New file: `fftEngine.ts`
Contents:
- `fft(buf)` — radix-2 Cooley-Tukey, unchanged
- `fftMagnitude(buf, sampleRate)` — magnitude + frequency bins, unchanged

**Verification:** Import from `WaveformDsoView.tsx`, delete old definitions, run `tsc`.

---

## Step 2: Extract Canvas Overlay Draw Hooks

### New file: `canvasOverlays.ts`

Factory functions that return uPlot draw hooks. Each takes a single `options` object of refs/values it needs — no closures over component scope.

```typescript
export interface TriggerLineOpts {
  getLevel: () => number;
  getSource: () => "ch1" | "ch2";
  getVdiv: () => number;
  getPos: (source: "ch1" | "ch2") => number;
}
export function makeDrawTriggerLine(opts: TriggerLineOpts): (u: uPlot) => void;

export interface PhosphorOpts {
  tracesRef: React.RefObject<TraceSnapshot[]>;
  enabledRef: React.RefObject<boolean>;
  rollingTriggerTimesRef: React.RefObject<number[]>;
  rollingLockedSnapRef: React.RefObject<TraceSnapshot | null>;
}
export function makeDrawPhosphor(opts: PhosphorOpts): (u: uPlot) => void;

export interface ReferenceOpts {
  snapRef: React.RefObject<TraceSnapshot | null>;
}
export function makeDrawReference(opts: ReferenceOpts): (u: uPlot) => void;

export interface CursorOpts {
  cursorARef: React.RefObject<{t:number;v:number}|null>;
  cursorBRef: React.RefObject<{t:number;v:number}|null>;
}
export function makeDrawCursors(opts: CursorOpts): (u: uPlot) => void;

export function makeDrawZoomBox(
  mainPlotRef: React.RefObject<uPlot | null>
): (u: uPlot) => void;
```

**Why factory functions?** uPlot hooks are registered at plot construction time. Factory functions let us pass the latest refs without recreating hooks on every render.

**Verification:** Replace inline closures in `buildPlot` with calls to these factories. Run `tsc`.

---

## Step 3: Extract `renderNow` into `renderEngine.ts`

### New file: `renderEngine.ts`

`renderNow` is currently a 200-line closure inside `pushData`. It needs:
- `plotRef` / `overviewPlotRef` (uPlot instances)
- `viewMode` (string)
- `sampleRateRef` (number)
- `mathRef` (MathState)
- `phosphorEnabledRef` (boolean)
- `horizontalRef` (HorizontalState)
- `triggerRef` (TriggerState)
- `ch1VerticalRef`, `ch2VerticalRef` (VerticalState)
- `windowMs` (number)
- `acquireModeRef` (for scale forcing)
- Refs for side effects: `phosphorTraces`, `forceTriggerRef`, `plotThrottleRef`, `chunkTimes`

Instead of passing 15 individual parameters, create a single `RenderContext` interface:

```typescript
export interface RenderContext {
  plot: uPlot;
  overviewPlot: uPlot | null;
  viewMode: "time" | "fft" | "xy";
  sampleRate: number;
  math: MathState;
  phosphorEnabled: boolean;
  horizontal: HorizontalState;
  trigger: TriggerState;
  ch1Vertical: VerticalState;
  ch2Vertical: VerticalState;
  windowMs: number;
  acquireMode: AcquireMode;
  // Mutable outputs
  phosphorTraces: TraceSnapshot[];
}

export function renderNow(
  ctx: RenderContext,
  ch1: number[],
  ch2: number[],
  opts?: { phosphorOnly?: boolean }
): void;
```

**Note:** `renderNow` will still call `plot.setData()`, `plot.setScale()`, etc. That's fine — this is the render engine's job. The key is that it's no longer a deeply nested closure.

**Why keep phosphor mutation here?** Phosphor capture is part of rendering policy. The snapshot is taken from the data that was just rendered. Extracting it further would split a coherent operation.

**Verification:** Replace the closure with a standalone function call. Run `tsc`. Test by verifying FFT, XY, time mode, peak detect, decimation, trigger alignment, math channel, overview, phosphor capture, and scale forcing all still work.

---

## Step 4: Extract Mode Logic from `pushData`

### New file: `acquireModes.ts`

The 430-line `pushData` function contains a mode switch that decides *when* to render. Extract the decision logic for each mode into testable functions:

```typescript
export type AcquireMode = "stopped" | "running" | "single-armed" | "single-held" | "rolling" | "averaging";

export interface ModeDecision {
  action: "render" | "render-phosphor-only" | "accumulate" | "suppress";
  ch1: number[];
  ch2: number[];
  // Mode-specific state updates
  setAcquireMode?: AcquireMode;
}

export function decideSingleArmed(
  sourceBuf: number[],
  ch1Buf: number[],
  ch2Buf: number[],
  detectTrigger: (buf: number[]) => boolean,
  renderAndStop: () => void,
): ModeDecision;

export function decideAveraging(
  sourceBuf: number[],
  ch1Buf: number[],
  ch2Buf: number[],
  detectTrigger: (buf: number[]) => boolean,
  accum: { count: number; buf1: number[]; buf2: number[] },
  targetCount: number,
  renderNow: (ch1: number[], ch2: number[]) => void,
): { decision: ModeDecision; nextAccum: typeof accum };

export function decideRolling(
  ch1Buf: number[],
  ch2Buf: number[],
  nowPerf: number,
  plotThrottle: number,
  findTriggerIndex: (buf: number[]) => number,
  rollingState: { triggerTimes: number[]; lockedSnap: TraceSnapshot | null },
  renderNow: (ch1: number[], ch2: number[]) => void,
): { decision: ModeDecision; nextRollingState: typeof rollingState };

export function decideRunning(
  sourceBuf: number[],
  ch1Buf: number[],
  ch2Buf: number[],
  triggerMode: "auto" | "normal" | "smart" | "single",
  smartState: { state: "auto" | "locked"; triggerCount: number; missCount: number },
  nowPerf: number,
  plotThrottle: number,
  renderNow: (ch1: number[], ch2: number[], opts?: { phosphorOnly?: boolean }) => void,
): { decision: ModeDecision; nextSmartState: typeof smartState };
```

**Important:** These are **decision functions**, not action functions. They return what should happen. The component still calls `renderNow`, `stop`, `setAcquireMode`, etc. This avoids the class-instance complexity of a full state machine while still making the logic testable and visible.

**Verification:** Replace the inline mode switch with calls to these decision functions. The `pushData` callback becomes:

```typescript
const pushData = useCallback((chunk: UsbDataChunk) => {
  // --- ingestion (unchanged) ---
  decode bytes, apply probe/invert/BW, buffer, trim...

  // --- measurements (unchanged) ---
  throttled calcMeasurements...

  // --- mode decision ---
  const mode = acquireModeRef.current;
  if (mode === "stopped" || mode === "single-held") return;

  const decision = decideMode({
    mode, sourceBuf, ch1Buf, ch2Buf,
    triggerRef, horizontalRef, sampleRateRef,
    smartStateRef, rollingStateRef,
    avgAccum, nowPerf, plotThrottleRef,
    renderNow: (c1, c2, opts) => renderNow(renderCtx, c1, c2, opts),
    stop,
    setAcquireMode,
  });

  // execute decision
  if (decision.action === "render") renderNow(renderCtx, decision.ch1, decision.ch2);
  // ... etc
}, [vpp, windowMs]);
```

Run `tsc`. Verify all modes still behave correctly.

---

## Step 5: Clean Up `buildPlot`

After Steps 1–4, `buildPlot` (currently ~380 lines) will be shorter because the draw hooks are factory calls. Further simplify by:

- Moving axis formatter functions (`timeAxisValues`, `freqAxisValues`, `voltAxisValues`) to module scope or `scopeConstants.ts`
- Keeping only the uPlot option assembly and initial scale setting in `buildPlot`

---

## File Structure After Refactor

```
frontend/src/plugins/waveforge/
  WaveformDsoView.tsx          # ~900 lines (orchestrator: state, effects, handlers, JSX)
  AcquireToolbar.tsx           # unchanged
  VerticalPanel.tsx            # unchanged
  HorizontalPanel.tsx          # unchanged
  TriggerPanel.tsx             # unchanged
  MathPanel.tsx                # unchanged
  MeasurementBar.tsx           # unchanged
  MeasurementsPanel.tsx        # unchanged
  CursorsPanel.tsx             # unchanged
  CollapsibleSection.tsx       # unchanged
  canvasOverlays.ts            # NEW ~220 lines
  waveformMath.ts            # NEW ~130 lines
  fftEngine.ts                 # NEW ~60 lines
  renderEngine.ts              # NEW ~220 lines
  acquireModes.ts              # NEW ~200 lines
  scopeTypes.ts                # unchanged
  scopeConstants.ts            # minor additions (axis formatters)
  RingBuffer.ts                # unchanged
  UsbTransport.ts              # unchanged
```

---

## Rollback Plan

If any step introduces a regression:
1. `git stash` or create a temporary branch
2. Revert to last known-good commit
3. The changes are additive (new files + import changes) — no existing files are heavily modified except `WaveformDsoView.tsx` imports and function calls

## Verification Commands

```bash
cd frontend && npx tsc --noEmit
```

After each step. Final verification: manual smoke test of all acquisition modes and view modes.
