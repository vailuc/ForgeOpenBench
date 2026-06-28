---
description: Add DSO toast notifications to WaveformDsoView
---

# Plan — DSO Toast Notifications

## Context

The `WaveformDsoView` refactor is complete. The user wants to add lightweight user-facing toast notifications in a follow-up PR. The toast system already exists globally (`useToastStore.ts` + `ToastContainer.tsx` in `App.tsx`). We will follow the same extraction pattern as the refactor: a thin `scopeToasts.ts` helper module, minimal changes in the component.

## Scope Decisions

1. **Architecture:** Option B — extract `frontend/src/plugins/waveforge/scopeToasts.ts` with named helpers.
2. **Mode-change toasts:** Add `info` toasts for `run`, `stop`, `single`, `rolling`, `averaging`. Keep them short (2s) to avoid noise.
3. **Disconnect/reconnect:** Add `warning` on unexpected disconnect and `info` on reconnect. Use a `useEffect` watching `connected` inside `WaveformDsoView.tsx`.
4. **Reference actions:** `success` toasts for save and clear.
5. **Autoset:** `success` on completion, `error` if it fails (no signal / cannot find settings).
6. **Error toasts:** `start()` failures, sample-rate change failures, transport-level failures propagated through `pushData`.
7. **No toasts for:** Every slider change, every trigger level change, normal render-loop events.

## Success Criteria

- `npx tsc --noEmit` passes with no new errors.
- No new React hooks in `scopeToasts.ts`; it uses the imperative `toast` API only.
- `WaveformDsoView.tsx` line count does not increase significantly (toast calls replace/adjacent to existing handlers, not bloat).
- Manual smoke test: verify toasts appear for run/stop/single, reference save/clear, disconnect/reconnect, and autoset.

## Implementation Steps

1. Create `frontend/src/plugins/waveforge/scopeToasts.ts`:
   - Import `toast` from `../../shared/hooks/useToastStore`.
   - Export named helpers:
     - `notifyStarted()`, `notifyStopped()`, `notifySingle()`, `notifyRolling()`, `notifyAveraging()`
     - `notifyConnected()`, `notifyDisconnected()`
     - `notifyReferenceSaved()`, `notifyReferenceCleared()`
     - `notifyAutoSetDone()`, `notifyAutoSetFailed()`
     - `notifyError(message: string)`
   - Use consistent `info` / `success` / `warning` / `error` variants and short durations for transient events.

2. Update `WaveformDsoView.tsx`:
   - Import helpers from `scopeToasts.ts`.
   - In `start()` / `stop()` / `handleSingle()` / toolbar handlers, call the relevant notify helpers after state changes succeed.
   - Add a `useEffect` watching `connected` to call `notifyConnected()` / `notifyDisconnected()`.
   - In `handleAutoSet()`, call `notifyAutoSetDone()` or `notifyAutoSetFailed()` based on result.
   - In `pushData` error paths and `start()` catch blocks, call `notifyError(message)`.

3. Verify:
   - `npx tsc --noEmit`
   - Manual smoke test of all listed toast events.

## Forbidden Actions

- Do not add a custom toast container or styling; reuse the existing global system.
- Do not add toasts inside the render loop or data throttle path.
- Do not refactor unrelated code while adding toasts; keep the diff focused.
