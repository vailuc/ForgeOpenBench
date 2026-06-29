import { CollapsibleSection } from "./CollapsibleSection";
import type { MathState } from "./scopeTypes";

interface Props {
  state: MathState;
  onChange: (s: MathState) => void;
  disabled: boolean;
  fftPeaksEnabled?: boolean;
  onToggleFftPeaks?: (v: boolean) => void;
}

export function MathPanel({ state, onChange, disabled, fftPeaksEnabled, onToggleFftPeaks }: Props) {
  return (
    <CollapsibleSection title="Math" defaultOpen={false}>
      {/* Enable */}
      <label className="flex items-center gap-1.5 text-[11px] text-fob-orange font-bold">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => onChange({ ...state, enabled: e.target.checked })}
          disabled={disabled}
          className="accent-fob-orange"
        />
        Math
      </label>

      {state.enabled && (
        <>
          {/* Source A */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fob-text-dim w-6">A</span>
            <select
              className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
              value={state.sourceA}
              onChange={(e) => onChange({ ...state, sourceA: e.target.value as "ch1" | "ch2" })}
              disabled={disabled}
            >
              <option value="ch1">CH1</option>
              <option value="ch2">CH2</option>
            </select>
          </div>

          {/* Operator */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fob-text-dim w-6">Op</span>
            <select
              className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
              value={state.op}
              onChange={(e) => onChange({ ...state, op: e.target.value as MathState["op"] })}
              disabled={disabled}
            >
              <option value="add">A + B</option>
              <option value="sub">A − B</option>
              <option value="mul">A × B</option>
              <option value="div">A / B</option>
              <option value="fft">FFT(A)</option>
              <option value="xy">XY (A vs B)</option>
            </select>
          </div>

          {/* FFT peak markers */}
          {state.op === "fft" && onToggleFftPeaks && (
            <label className="flex items-center gap-1.5 text-[11px] text-fob-text font-bold">
              <input
                type="checkbox"
                checked={fftPeaksEnabled ?? false}
                onChange={(e) => onToggleFftPeaks(e.target.checked)}
                disabled={disabled}
                className="accent-fob-orange"
              />
              Peak markers
            </label>
          )}

          {/* Source B */}
          {state.op !== "fft" && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-fob-text-dim w-6">B</span>
              <select
                className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
                value={state.sourceB}
                onChange={(e) => onChange({ ...state, sourceB: e.target.value as "ch1" | "ch2" })}
                disabled={disabled}
              >
                <option value="ch1">CH1</option>
                <option value="ch2">CH2</option>
              </select>
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}
