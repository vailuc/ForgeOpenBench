# Proposal: Full Acquire State Machine Architecture
## For WaveForge DSO — Separating Ingestion from UI State

---

## 1. The Problem with Current Architecture

### Current Flow (monolithic, inline)

```
UsbTransport.onData ──> pushData() ──> [accumulate buffers] ──> [compute measurements] ──> [decide: render or not?] ──> [maybe plot] ──> [maybe check single-shot trigger] ──> [maybe stop]
```

All logic lives in one `pushData` callback. This works for basic streaming but becomes a mess when adding:
- Single-shot mode (must suppress renders while armed)
- Average mode (must accumulate N frames before rendering)
- Roll mode (must bypass trigger and stream continuously)
- Digital phosphor (must accumulate density over frames)

The current code already shows this strain:
- `singleArmedRef` + `singleJustTriggeredRef` + manual render suppression
- `pausedRef` that freezes display but data still accumulates (unclear intent)
- Math channel computation inline with buffer processing
- No clean way to add frame averaging or persistence heatmap

### Problems

| Problem | Current Symptom |
|---------|-----------------|
| Tight coupling | Adding a mode requires touching `pushData`, `start`, `stop`, `onStopped`, toolbar handlers |
| Render logic mixed with acquisition logic | `plotThrottleRef` decides when to draw, but single-shot must override this |
| No frame abstraction | Can't reason about "this is frame 3 of 16 for averaging" |
| Buffer lifecycle unclear | `ch1Buf` is both live accumulation buffer and display buffer — who owns it? |
| Restart logic scattered | Auto-restart on `onStopped` conflicts with intentional stop after single-shot |

---

## 2. Proposed Architecture

### Three Layers, Strict Separation

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: RENDER (uPlot, canvas overlays, measurement bar)       │
│  Reads: currentFrame, persistFrames, avgFrames                  │
│  Does NOT talk to transport directly                            │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2: ACQUIRE STATE MACHINE                                 │
│  Reads: ringBuffer (continuous stream)                          │
│  Writes: currentFrame, triggerStatus, measurements              │
│  Decides: when to render, what mode, when to stop             │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 1: INGESTION (UsbTransport.onData)                       │
│  Reads: raw binary chunks from WebSocket                        │
│  Writes: ringBuffer (circular, fixed size)                     │
│  Does NOT make any UI or state decisions                      │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 1: Ingestion Engine

```typescript
// Only job: convert raw bytes to voltage samples, push to ring buffer
const RING_SIZE = 1_000_000; // samples per channel
const ringCh1 = new Float64Array(RING_SIZE);
const ringCh2 = new Float64Array(RING_SIZE);
let ringWriteIdx = 0;

function ingest(chunk: UsbDataChunk) {
  for (let i = 0; i < bytes.length; i += 2) {
    ringCh1[ringWriteIdx] = (bytes[i] - 128) * gain + offset;
    ringCh2[ringWriteIdx] = (bytes[i+1] - 128) * gain + offset;
    ringWriteIdx = (ringWriteIdx + 1) % RING_SIZE;
  }
  // Notify state machine that new data is available
  stateMachine.onDataAvailable(ringWriteIdx, chunk.rate);
}
```

**Key rule:** Ingestion never checks `running`, `paused`, `singleArmed`, or anything UI-related. It just fills the ring.

### Layer 2: Acquire State Machine

```typescript
type AcquireMode = "run" | "single-armed" | "single-held" | "roll" | "average" | "stopped";

interface StateMachine {
  mode: AcquireMode;
  
  // Called by ingestion whenever new data arrives
  onDataAvailable(writeIdx: number, rate: number): void;
  
  // Called by UI (toolbar buttons)
  requestRun(): void;
  requestStop(): void;
  requestSingle(): void;
  requestClear(): void;
  
  // Called by render loop (~20fps via requestAnimationFrame)
  getFrameToRender(): Frame | null;
  
  // Current status for UI
  getStatus(): { mode: AcquireMode; triggerStatus: "armed" | "triggered" | "idle"; framesCaptured: number; };
}
```

**Mode behaviors:**

| Mode | What `onDataAvailable` does | What `getFrameToRender` returns | Auto-stop? |
|------|----------------------------|--------------------------------|------------|
| `run` | Software trigger check; if triggered, extract window around trigger point | Latest triggered window | No |
| `single-armed` | Accumulate to full memory depth; check trigger; if triggered → `single-held` | `null` (suppress render) | On trigger |
| `single-held` | Nothing (frozen) | The captured frame (held) | Already stopped |
| `roll` | FIFO append-right, discard-left based on s/div | Rolling window of last N samples | No |
| `average` | Accumulate frame to avg buffer; increment counter | Averaged frame (every Nth trigger) | No |
| `stopped` | Nothing | `null` | — |

### Layer 3: Render Loop

```typescript
function renderLoop() {
  const frame = stateMachine.getFrameToRender();
  if (frame) {
    drawToCanvas(frame);
    updateMeasurements(frame);
  }
  updateToolbarStatus(stateMachine.getStatus());
  requestAnimationFrame(renderLoop);
}
```

**Key rule:** Render loop is decoupled from data arrival. It polls the state machine at display refresh rate. No throttling hacks needed.

---

## 3. How This Affects the Current Plan

### Current Plan (Phase 1–4)

| Phase | Feature | Status | Impact of State Machine |
|-------|---------|--------|--------------------------|
| **Phase 1** | Layout skeleton, panels, toolbar, stepped scales, trigger line, measurements, Autoset | **DONE** | **Minimal impact** — these are UI structure and compute functions. State machine doesn't change them. |
| **Phase 2** | Trigger panel, math channels, single-shot, reference waveforms | **Partially done** — trigger panel and math rendering done. Single-shot is bolted-on. | **High impact** — single-shot needs redesign. Reference waveform save/load fits naturally with Frame abstraction. |
| **Phase 3** | FFT, XY mode, digital phosphor | Not started | **High impact** — FFT needs frame access. Digital phosphor needs multi-frame accumulation, which the state machine handles natively. |
| **Phase 4** | Average mode, peak detect, roll mode, dual window, more decoders | Not started | **Very high impact** — these ARE the state machine. Without it, they're hacks. With it, they're clean mode implementations. |

### Refactoring Cost

The current `WaveformDsoView.tsx` is ~600 lines. A clean separation would require:

**New files to create:**
1. `IngestionEngine.ts` — ~80 lines. Pure data conversion, ring buffer management.
2. `AcquireStateMachine.ts` — ~200 lines. Mode logic, trigger detection, frame extraction.
3. `Frame.ts` — ~30 lines. Data structure: `interface Frame { ch1: Float64Array; ch2: Float64Array; ts: number; triggerOffset: number; rate: number; }`
4. `RenderEngine.ts` — ~100 lines. uPlot setup, math trace computation, cursor overlay.

**Files to modify:**
- `WaveformDsoView.tsx` — shrink from ~600 to ~150 lines. Becomes orchestrator: create ingestion, create state machine, wire to panels, start render loop.
- `AcquireToolbar.tsx` — button handlers now call `stateMachine.requestRun()` instead of inline logic.
- `MeasurementBar.tsx` — reads from `frame.measurements` instead of inline `calcMeasurements`.

**Estimated effort:** 4-6 hours to refactor + verify existing features still work.

---

## 4. Recommendation: When to Implement

### Option A: Finish Current Plan First, Then Refactor (Conservative)

**Sequence:**
1. Complete Phase 2 (reference waveforms)
2. Complete Phase 3 (FFT, XY, phosphor as best-effort)
3. Complete Phase 4 (average, roll, peak detect as best-effort)
4. **THEN** refactor to state machine to clean up the accumulated technical debt

**Pros:**
- You ship something that works end-to-end sooner
- Users see visible progress (FFT, XY mode)
- Refactor has a complete feature set to preserve

**Cons:**
- Phases 3-4 will be built on shaky foundations
- Digital phosphor without frame abstraction is painful
- Average mode without frame abstraction is nearly impossible to do cleanly
- Total code volume before refactor is larger = more to rewrite
- Risk: "we'll refactor later" often becomes "we never refactor"

### Option B: Pause, Implement State Machine Now, Then Resume (Aggressive)

**Sequence:**
1. **PAUSE** current plan at end of Phase 1 (layout is done, that's the foundation)
2. Extract `IngestionEngine`, `AcquireStateMachine`, `Frame`, `RenderEngine`
3. Rewrite `WaveformDsoView` as thin orchestrator
4. Re-implement single-shot cleanly in state machine
5. **THEN** resume Phase 2-4 on clean foundation

**Pros:**
- Phase 2-4 features become trivial to implement (they're just mode handlers)
- Single-shot, average, roll, phosphor all benefit immediately
- Less total code written (no throwaway Phase 2-4 hack code)
- The architecture is correct from the start

**Cons:**
- No visible new features for 1-2 sessions (all infrastructure work)
- Risk of introducing regressions in already-working Phase 1
- User (you) doesn't see progress screenshots

### Option C: Hybrid — State Machine Lite (Recommended)

**Sequence:**
1. Keep current Phase 1 layout and panels (they're fine)
2. Extract ONLY the frame extraction + mode logic from `pushData` into a lightweight state machine
3. Keep `pushData` as ingestion, but have it call `stateMachine.onFrame(frame)` instead of direct render
4. Re-implement single-shot, average, roll as mode switches in this lightweight machine
5. Leave full ingestion/render separation for a future v0.3 refactor

**Implementation:**
```typescript
// In WaveformDsoView.tsx — add this, don't rewrite everything
const [acquireMode, setAcquireMode] = useState<"run" | "single" | "roll" | "avg" | "stop">("stop");

const onFrame = useCallback((frame: Frame) => {
  switch (acquireMode) {
    case "run": renderFrame(frame); break;
    case "single": 
      if (checkTrigger(frame)) { renderFrame(frame); setAcquireMode("stop"); }
      break;
    case "avg": accumulateAndMaybeRender(frame); break;
    case "roll": appendToRollBuffer(frame); break;
    case "stop": break;
  }
}, [acquireMode]);
```

**Pros:**
- Minimal rewrite (~2 hours)
- Phases 2-4 can proceed immediately on cleaner foundation
- Existing Phase 1 untouched
- Can evolve into full separation later

**Cons:**
- Not as clean as full separation
- Still some coupling between layers

---

## 5. My Recommendation

**Go with Option C: State Machine Lite.**

Reasoning:
- Phase 1 layout is solid and shouldn't be touched
- The pain point is specifically `pushData` being a kitchen sink
- A lightweight mode switch in `pushData` (or just after it) solves 80% of the problem with 20% of the effort
- Full separation (Option B) is architecturally pure but unnecessary for v0.2
- After v0.2 ships with FFT/XY/phosphor, then consider full separation for v0.3

**Immediate next steps for Option C:**
1. Add `acquireMode` state: `"stopped" | "running" | "single-armed" | "single-held" | "rolling" | "averaging"`
2. Wrap the existing plot render block in a mode switch
3. Move single-shot logic from inline refs to mode-based logic
4. Add roll mode: at slow s/div, bypass trigger and do FIFO render
5. Add average mode: accumulate N frames in `avgBuf`, divide, render

This gives you all the modes from your idea dump without a full rewrite.

---

## 6. Decision Required

| Option | Effort | Risk | New Features Sooner | Architecture Quality |
|--------|--------|------|---------------------|---------------------|
| A: Finish plan, refactor later | Medium | High (debt accumulates) | Yes | Low |
| B: Full state machine now | High (4-6h) | Medium (regressions) | No | High |
| C: State machine lite | Low (2h) | Low | Yes | Medium |

**Which option?** If you want to see FFT and XY mode working in the next session: **C**.
If you want perfect architecture before any new features: **B**.
If you want to ship what we have and refactor much later: **A**.
