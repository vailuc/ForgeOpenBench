import { MeterMode, modeLabel } from "./types";

const V_MODES: MeterMode[] = [MeterMode.DcVoltage, MeterMode.AcVoltage];
const A_MODES: MeterMode[] = [MeterMode.DcCurrent, MeterMode.AcCurrent];
const OHM_MODES: MeterMode[] = [
  MeterMode.Resistance,
  MeterMode.Diode,
  MeterMode.Continuity,
  MeterMode.Temperature,
  MeterMode.Capacitance,
];

interface ModeBarProps {
  currentMode: MeterMode;
  onSelect: (m: MeterMode) => void;
  switchPos: string | null;
}

export function ModeBar({ currentMode, onSelect, switchPos }: ModeBarProps) {
  const banks: { label: string; modes: MeterMode[]; key: "V" | "A" | "Ω" }[] = [
    { label: "V", modes: V_MODES, key: "V" },
    { label: "A", modes: A_MODES, key: "A" },
    { label: "Ω", modes: OHM_MODES, key: "Ω" },
  ];

  return (
    <div className="rounded border border-fob-border bg-fob-surface p-3 flex flex-col justify-center gap-3 min-h-0 overflow-y-auto">
      {banks.map((bank, bankIdx) => {
        const bankActive = switchPos === bank.key;
        return (
          <div key={bank.key} className="flex items-center gap-2">
            {bankIdx > 0 && <div className="hidden sm:block mx-1 h-8 w-px bg-fob-border" />}
            <span
              className={[
                "text-sm font-bold font-mono w-4 text-center shrink-0",
                bankActive ? "text-fob-orange" : "text-fob-text-dim",
              ].join(" ")}
              title={bankActive ? "Switch position" : undefined}
            >
              {bank.label}
            </span>
            <div className="flex flex-wrap gap-2">
              {bank.modes.map((m) => (
                <button
                  key={m}
                  onClick={() => onSelect(m)}
                  className={`px-4 py-2 rounded text-sm font-mono uppercase tracking-wider transition-colors ${
                    currentMode === m
                      ? "bg-fob-orange text-fob-bg font-bold"
                      : "bg-fob-bg text-fob-text border border-fob-border hover:text-fob-text"
                  }`}
                >
                  {modeLabel(m)}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
