# Scope Engine Architecture Notes
## From Idea Dump — Streaming vs Batching

## Core Principle
**Separate data ingestion from UI state machine.**

The ingestion engine pulls raw data into a local buffer. The UI state dictates how that data is processed and displayed.

---

## Default State: Continuous "Live" Loop

```
[Hardware Stream] ──> [Ring Buffer] ──> [Software Trigger Check] ──> [Render Pipeline] ──> Repeat
```

- Hardware streams millions of samples per second
- Browser renders at 60-144Hz
- Frontend continuously reads into rolling ring buffer
- Software trigger isolates a window
- Push to GUI, immediately loop back

**Implementation:** This is already what the current `pushData` + `plotThrottleRef` does.

---

## Mode A: Single Shot (On-Demand Capture)

**Use case:** Hunting one-time events — power-on spike, erratic reset pin, glitch.

**Behavior:**
1. User clicks **Single** → scope enters "Armed" state
2. Continuously reads data into memory but **does NOT update UI**
3. Software trigger condition met → capture one final full memory-depth window
4. Force single UI frame update
5. Immediately drop into **Stop** state
6. Shutdown reading until user hits **Run** again

**Implementation TODO:**
- Add `singleArmed` ref flag
- In `pushData`: if `singleArmed`, accumulate buffer but skip plot redraw
- When trigger condition met: set `singleArmed = false`, draw one frame, call `stop(true)`
- UI: "Single" button arms, changes to "Armed...", then "Single" again after capture

---

## Mode B: Roll Mode (Slow-Scan Strip Chart)

**Use case:** Very slow timebases (≥500ms/div, ≥1s/div). Waiting for full frame buffer would feel broken.

**Behavior:**
- Bypass trigger engine entirely
- Continuous FIFO shift register mode
- New bytes appended right, old samples slide off left
- Like a medical heart rate monitor
- No trigger wait — just scroll

**Implementation TODO:**
- Detect `sDiv >= 0.5` (500ms/div)
- Change render: instead of `setData([xs, ch1, ch2])`, append new points to right edge
- Use uPlot's streaming mode or manual canvas shift
- Disable trigger line display

---

## Mode C: Average / Equivalent Time Sampling

**Use case:** Clean up noisy signals, push hardware limits.

**Behavior:**
- Merge multiple successive captures into cumulative display buffer
- Math:
  ```
  DisplayBuffer[i] = (DisplayBuffer[i] * 0.9) + (NewSample[i] * 0.1)
  ```
- Running average smooths random noise, leaves clean periodic signal

**Implementation TODO:**
- Add `averageFrames` counter
- Accumulate N frames into `avgBuf1`, `avgBuf2`
- Divide by N before rendering
- Reset accumulator when settings change

---

## State Machine Summary

| State | Trigger | UI Update | Buffer Behavior |
|-------|---------|-----------|-----------------|
| Run (default) | Software check, auto-restart | Throttled ~20fps | Ring buffer, window trim |
| Single (armed) | Software check, stop on hit | None until hit | Accumulate full memory depth |
| Single (captured) | Frozen | One frame | Held, no new data |
| Roll | Disabled | Continuous FIFO | Append-right, shift-left |
| Average | Software check | Throttled ~20fps | Cumulative average over N frames |
| Stop | Disabled | Frozen | Cleared |

---

## UI State Machine

```typescript
type AcquireState = "stopped" | "running" | "single-armed" | "single-held" | "rolling" | "averaging";

// Transitions:
// stopped + Run → running
// stopped + Single → single-armed
// running + Stop → stopped
// running + Single → single-armed
// single-armed + trigger hit → single-held
// single-held + Run → running
// single-held + Single → single-armed (re-arm)
// any + Roll toggle → rolling / running
```

---

## Next Implementation Priority

1. **Single Shot mode** — arm/capture/hold cycle
2. **Math channel rendering** — compute and draw 3rd trace
3. **Reference waveform** — save/load golden trace
4. **Roll mode** — FIFO scroll at slow timebases
5. **Average mode** — cumulative frame averaging

## Files to Touch

- `WaveformDsoView.tsx` — add `acquireState` machine, Single logic
- `AcquireToolbar.tsx` — button states reflect acquire mode
- `HorizontalPanel.tsx` — roll mode already has checkbox, wire it
- `MathPanel.tsx` — already has op selector, wire to render
- New: `mathEngine.ts` — compute CH1±CH2, CH1×CH2 from buffers
