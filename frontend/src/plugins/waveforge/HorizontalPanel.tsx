import { CollapsibleSection } from "./CollapsibleSection";
import { SDIV_STEPS, formatSDiv, sDivToWindowMs, SAMPLE_RATES_DSO } from "./scopeConstants";
import type { HorizontalState } from "./scopeTypes";

interface Props {
  state: HorizontalState;
  onChange: (s: HorizontalState) => void;
  sampleRate: number;
  onSampleRateChange: (hz: number) => void;
  disabled: boolean;
}

export function HorizontalPanel({ state, onChange, sampleRate, onSampleRateChange, disabled }: Props) {
  const windowMs = sDivToWindowMs(state.sDiv);

  return (
    <CollapsibleSection title="Horizontal" defaultOpen>
      {/* Sample Rate */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Rate</span>
        <select
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          value={sampleRate}
          onChange={(e) => onSampleRateChange(Number(e.target.value))}
          disabled={disabled}
        >
          {SAMPLE_RATES_DSO.map((r) => (
            <option key={r.hz} value={r.hz}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* s/div */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">s/div</span>
        <select
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          value={state.sDiv}
          onChange={(e) => onChange({ ...state, sDiv: Number(e.target.value) })}
          disabled={disabled}
        >
          {SDIV_STEPS.map((s) => (
            <option key={s} value={s}>{formatSDiv(s)}</option>
          ))}
        </select>
      </div>

      {/* Horizontal Position (delay) */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Delay</span>
        <input
          type="range"
          min={-50}
          max={50}
          step={1}
          value={state.position}
          onChange={(e) => onChange({ ...state, position: Number(e.target.value) })}
          disabled={disabled}
          className="flex-1 min-w-0 accent-fob-orange"
        />
        <span className="text-[10px] text-fob-text-dim w-8 text-right">{state.position}%</span>
      </div>

      {/* Window readout */}
      <div className="text-[10px] text-fob-text-dim text-right">
        {windowMs < 1 ? `${(windowMs * 1000).toFixed(0)}µs window` : `${windowMs.toFixed(1)}ms window`}
      </div>

      {/* Acquire Mode */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Acq</span>
        <select
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          value={state.acquireMode}
          onChange={(e) => onChange({ ...state, acquireMode: e.target.value as "normal" | "peak" | "average" })}
          disabled={disabled}
        >
          <option value="normal">Normal</option>
          <option value="peak">Peak Detect</option>
          <option value="average">Average</option>
        </select>
      </div>

      {state.acquireMode === "average" && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-fob-text-dim w-10">Avg</span>
          <input
            type="number"
            min={2}
            max={1024}
            step={1}
            value={state.averageCount}
            onChange={(e) => onChange({ ...state, averageCount: Math.max(2, Math.min(1024, Number(e.target.value))) })}
            disabled={disabled}
            className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          />
        </div>
      )}

      {/* Roll Mode */}
      <label className="flex items-center gap-1.5 text-[10px] text-fob-text-dim">
        <input
          type="checkbox"
          checked={state.rollMode}
          onChange={(e) => onChange({ ...state, rollMode: e.target.checked })}
          disabled={disabled}
          className="accent-fob-orange"
        />
        Roll Mode
      </label>
    </CollapsibleSection>
  );
}
