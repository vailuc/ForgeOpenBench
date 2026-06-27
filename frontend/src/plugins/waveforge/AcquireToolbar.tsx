interface Props {
  running: boolean;
  paused: boolean;
  onRun: () => void;
  onStop: () => void;
  onSingle: () => void;
  onAutoSet: () => void;
  onForceTrigger: () => void;
  onClear: () => void;
  triggerMode: "auto" | "normal" | "single" | "smart";
  onSetTriggerMode: (mode: "auto" | "normal" | "single" | "smart") => void;
  sampleRateLabel: string;
  sDivLabel: string;
  connected: boolean;
}

export function AcquireToolbar({
  running, paused, onRun, onStop, onSingle, onAutoSet, onForceTrigger, onClear,
  triggerMode, onSetTriggerMode,
  sampleRateLabel, sDivLabel, connected,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-fob-border bg-fob-surface h-[44px] shrink-0 select-none">
      {/* Acquire buttons — hardware order */}
      <button
        onClick={onRun}
        disabled={running || !connected}
        className="px-3 py-1 rounded bg-fob-green text-fob-accent-text font-bold text-[11px] hover:bg-fob-green/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Run
      </button>
      <button
        onClick={onStop}
        disabled={!running}
        className="px-3 py-1 rounded bg-fob-red text-fob-accent-text font-bold text-[11px] hover:bg-fob-red/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Stop
      </button>
      <button
        onClick={onSingle}
        disabled={!connected}
        className="px-3 py-1 rounded bg-fob-blue text-fob-accent-text font-bold text-[11px] hover:bg-fob-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Single
      </button>
      <div className="w-px h-5 bg-fob-border mx-1" />
      <button
        onClick={onAutoSet}
        disabled={!connected}
        className="px-3 py-1 rounded bg-fob-orange text-fob-accent-text font-bold text-[11px] hover:bg-fob-orange/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        AutoSet
      </button>
      <button
        onClick={onForceTrigger}
        disabled={!connected || !running}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Force Trig
      </button>
      <button
        onClick={onClear}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors"
      >
        Clear
      </button>
      <div className="w-px h-5 bg-fob-border mx-1" />
      {/* Trigger mode toggle — auto / normal / single / smart */}
      <div className="flex rounded overflow-hidden border border-fob-border">
        {(["auto", "normal", "single", "smart"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onSetTriggerMode(m)}
            className={`px-2 py-1 text-[11px] font-bold transition-colors ${
              triggerMode === m
                ? "bg-fob-blue text-fob-accent-text"
                : "bg-fob-surface text-fob-text hover:bg-fob-border"
            }`}
          >
            {m === "auto" ? "Auto" : m === "normal" ? "Norm" : m === "single" ? "Single" : "Smart"}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* Status readouts */}
      <span className="text-[10px] text-fob-text-dim font-mono">{sampleRateLabel}</span>
      <span className="text-[10px] text-fob-text-dim font-mono">{sDivLabel}</span>
      <span className={`w-2 h-2 rounded-full ${connected ? "bg-fob-green" : "bg-fob-border"}`} />
      <span className="text-[10px] text-fob-text-dim font-mono">{connected ? "USB" : "OFF"}</span>
      {running && !paused && (
        <span className="text-[10px] text-fob-green font-mono animate-pulse">ACQ</span>
      )}
      {paused && (
        <span className="text-[10px] text-fob-orange font-mono">HOLD</span>
      )}
    </div>
  );
}
