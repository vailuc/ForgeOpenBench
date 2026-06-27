import { CollapsibleSection } from "./CollapsibleSection";
import type { TriggerState } from "./scopeTypes";

interface Props {
  state: TriggerState;
  onChange: (s: TriggerState) => void;
  disabled: boolean;
  onSet50Percent: () => void;
}

export function TriggerPanel({ state, onChange, disabled, onSet50Percent }: Props) {
  return (
    <CollapsibleSection title="Trigger" defaultOpen>
      {/* Source */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Source</span>
        <select
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          value={state.source}
          onChange={(e) => onChange({ ...state, source: e.target.value as TriggerState["source"] })}
          disabled={disabled}
        >
          <option value="ch1">CH1</option>
          <option value="ch2">CH2</option>
          <option value="ext">Ext</option>
          <option value="acline">AC Line</option>
        </select>
      </div>

      {/* Level */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Level</span>
        <input
          type="range"
          min={-5}
          max={5}
          step={0.01}
          value={state.level}
          onChange={(e) => onChange({ ...state, level: Number(e.target.value) })}
          disabled={disabled}
          className="flex-1 min-w-0 accent-fob-orange"
        />
        <button
          onClick={onSet50Percent}
          disabled={disabled}
          className="px-1.5 rounded bg-fob-bg border border-fob-border hover:bg-fob-border text-[10px] disabled:opacity-40"
          title="Set to 50% of signal"
        >
          50%
        </button>
      </div>
      <input
        type="number"
        step={0.01}
        value={state.level}
        onChange={(e) => onChange({ ...state, level: Number(e.target.value) })}
        disabled={disabled}
        className="w-full bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
      />

      {/* Slope */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Slope</span>
        <div className="flex gap-1 flex-1">
          <button
            onClick={() => onChange({ ...state, slope: "rise" })}
            disabled={disabled}
            className={`flex-1 px-1 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              state.slope === "rise"
                ? "bg-fob-orange/20 border-fob-orange text-fob-orange"
                : "bg-fob-bg border-fob-border text-fob-text-dim hover:text-fob-text"
            } disabled:opacity-40`}
          >
            ▲ Rise
          </button>
          <button
            onClick={() => onChange({ ...state, slope: "fall" })}
            disabled={disabled}
            className={`flex-1 px-1 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              state.slope === "fall"
                ? "bg-fob-orange/20 border-fob-orange text-fob-orange"
                : "bg-fob-bg border-fob-border text-fob-text-dim hover:text-fob-text"
            } disabled:opacity-40`}
          >
            ▼ Fall
          </button>
          <button
            onClick={() => onChange({ ...state, slope: "both" })}
            disabled={disabled}
            className={`flex-1 px-1 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              state.slope === "both"
                ? "bg-fob-orange/20 border-fob-orange text-fob-orange"
                : "bg-fob-bg border-fob-border text-fob-text-dim hover:text-fob-text"
            } disabled:opacity-40`}
          >
            ◆ Both
          </button>
        </div>
      </div>

      {/* Mode */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Mode</span>
        <select
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          value={state.mode}
          onChange={(e) => onChange({ ...state, mode: e.target.value as TriggerState["mode"] })}
          disabled={disabled}
        >
          <option value="smart">Auto</option>
          <option value="normal">Normal</option>
          <option value="single">Single</option>
          <option value="auto">Free</option>
        </select>
      </div>

      {/* Coupling */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Coup</span>
        <select
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
          value={state.coupling}
          onChange={(e) => onChange({ ...state, coupling: e.target.value as TriggerState["coupling"] })}
          disabled={disabled}
        >
          <option value="dc">DC</option>
          <option value="ac">AC</option>
          <option value="hfrej">HF Reject</option>
          <option value="lfrej">LF Reject</option>
          <option value="noiserej">Noise Rej</option>
        </select>
      </div>

      {/* Holdoff */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-fob-text-dim w-10">Holdoff</span>
        <input
          type="number"
          min={0}
          max={10}
          step={0.1}
          value={state.holdoff}
          onChange={(e) => onChange({ ...state, holdoff: Number(e.target.value) })}
          disabled={disabled}
          className="flex-1 bg-fob-bg border border-fob-border rounded px-1 py-0.5 text-[11px] text-fob-text"
        />
        <span className="text-[10px] text-fob-text-dim">s</span>
      </div>
    </CollapsibleSection>
  );
}
