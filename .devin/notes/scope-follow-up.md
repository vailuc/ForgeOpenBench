# Scope Follow-up Tasks

## Accessibility: Form field labels
- **Context:** Chrome DevTools reports ~43 warnings: "A form field element should have an id or name attribute" and "No label associated with a form field".
- **Location:** Right-side control panels in `WaveformDsoView` (Vertical, Horizontal, Trigger sliders/selects/checkboxes).
- **Impact:** Non-functional; clutters console and hurts accessibility.
- **Action:** Add `id`/`htmlFor` or `aria-label` associations to all form inputs in the scope control panels.
- **Priority:** Low / deferred until after LA scope work is complete.
