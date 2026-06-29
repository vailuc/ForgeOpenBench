# Scope Follow-up Tasks

## Autoset: half-wave / asymmetric duty-cycle heuristic (needs hardware review)
- **Context:** `autoset()` in `waveformMath.ts` has a pulse-width period recovery path that fires when `duty < 35%` or `duty > 65%`. It recovers the full period from the measured pulse width.
- **Status:** Logic is sound and covered by unit tests, but has NOT been validated on real hardware with actual half-wave rectified signals.
- **Risk:** If `calcMeasurements` over- or under-counts crossings on a noisy half-wave, the recovered period could be wrong, causing s/div to jump unexpectedly.
- **Action:** Test Autoset on the signal generator with: (1) half-wave sine, (2) 25% duty square, (3) 75% duty square, across several frequencies. Compare s/div result to expected period.
- **Location:** `waveformMath.ts:128–136` (duty guard), `calcMeasurements` period detection.
- **Priority:** Medium — review before merging to main.

## Accessibility: Form field labels
- **Context:** Chrome DevTools reports ~43 warnings: "A form field element should have an id or name attribute" and "No label associated with a form field".
- **Location:** Right-side control panels in `WaveformDsoView` (Vertical, Horizontal, Trigger sliders/selects/checkboxes).
- **Impact:** Non-functional; clutters console and hurts accessibility.
- **Action:** Add `id`/`htmlFor` or `aria-label` associations to all form inputs in the scope control panels.
- **Priority:** Low / deferred until after LA scope work is complete.
