import { CollapsibleSection } from "./CollapsibleSection";
import { VDIV_STEPS, formatVDiv } from "./scopeConstants";
import type { VerticalState } from "./scopeTypes";

interface Props {
  ch1: VerticalState;
  ch2: VerticalState;
  onCh1Change: (s: VerticalState) => void;
  onCh2Change: (s: VerticalState) => void;
  disabled: boolean;
}

function ChannelControls({
  label, color, state, onChange, disabled,
}: {
  label: string;
  color: string;
  state: VerticalState;
  onChange: (s: VerticalState) => void;
  disabled: boolean;
}) {
  const accent = color === "orange" ? "accent-fob-orange" : "accent-fob-blue";
  const textColor = color === "orange" ? "text-fob-orange" : "text-fob-blue";

  return (
    <div className="flex flex-col gap-1 border-b border-fob-border pb-2 last:border-b-0 last:pb-0">
      {/* Enable + Label */}
      <label className={`flex items-center gap-1.5 font-bold text-[11px] ${textColor}`}>
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => onChange({ ...state, enabled: e.target.checked })}
          disabled={disabled}
          className={accent}
        />
        {label}
      </label>

      {state.enabled && (
        <>
          {/* V/div */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fob-text-dim w-8">V/div</span>
            <select
              className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
              value={state.vDiv}
              onChange={(e) => onChange({ ...state, vDiv: Number(e.target.value) })}
              disabled={disabled}
            >
              {VDIV_STEPS.map((v) => (
                <option key={v} value={v}>{formatVDiv(v)}</option>
              ))}
            </select>
          </div>

          {/* Position (divisions) */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fob-text-dim w-8">Pos</span>
            <button
              onClick={() => onChange({ ...state, position: Math.max(-5, state.position - 0.5) })}
              disabled={disabled}
              className="px-1 rounded bg-fob-bg border border-fob-border hover:bg-fob-border text-[10px] disabled:opacity-40"
            >
              -
            </button>
            <input
              type="range"
              min={-5}
              max={5}
              step={0.1}
              value={state.position}
              onChange={(e) => onChange({ ...state, position: Number(e.target.value) })}
              disabled={disabled}
              className={`flex-1 min-w-0 ${accent}`}
            />
            <button
              onClick={() => onChange({ ...state, position: Math.min(5, state.position + 0.5) })}
              disabled={disabled}
              className="px-1 rounded bg-fob-bg border border-fob-border hover:bg-fob-border text-[10px] disabled:opacity-40"
            >
              +
            </button>
          </div>
          <div className="text-right text-[10px] text-fob-text-dim">{state.position.toFixed(1)} div</div>

          {/* Coupling */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fob-text-dim w-8">Coup</span>
            <select
              className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
              value={state.coupling}
              onChange={(e) => onChange({ ...state, coupling: e.target.value as "dc" | "ac" | "gnd" })}
              disabled={disabled}
            >
              <option value="dc">DC</option>
              <option value="ac">AC</option>
              <option value="gnd">GND</option>
            </select>
          </div>

          {/* Probe */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-fob-text-dim w-8">Prb</span>
            <select
              className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
              value={state.probe}
              onChange={(e) => onChange({ ...state, probe: Number(e.target.value) as 1 | 10 | 100 })}
              disabled={disabled}
            >
              <option value={1}>1X</option>
              <option value={10}>10X</option>
              <option value={100}>100X</option>
            </select>
          </div>

          {/* Invert + BW Limit */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-[10px] text-fob-text-dim">
              <input
                type="checkbox"
                checked={state.invert}
                onChange={(e) => onChange({ ...state, invert: e.target.checked })}
                disabled={disabled}
                className={accent}
              />
              Inv
            </label>
            <label className="flex items-center gap-1 text-[10px] text-fob-text-dim">
              <input
                type="checkbox"
                checked={state.bwLimit}
                onChange={(e) => onChange({ ...state, bwLimit: e.target.checked })}
                disabled={disabled}
                className={accent}
              />
              BW20
            </label>
          </div>
        </>
      )}
    </div>
  );
}

export function VerticalPanel({ ch1, ch2, onCh1Change, onCh2Change, disabled }: Props) {
  return (
    <CollapsibleSection title="Vertical" defaultOpen>
      <ChannelControls
        label="CH1"
        color="orange"
        state={ch1}
        onChange={onCh1Change}
        disabled={disabled}
      />
      <ChannelControls
        label="CH2"
        color="blue"
        state={ch2}
        onChange={onCh2Change}
        disabled={disabled}
      />
    </CollapsibleSection>
  );
}
