import type { Measurements, MeasurementKey } from "./scopeTypes";

interface Props {
  ch1: Measurements;
  ch2: Measurements;
  ch1Keys: MeasurementKey[];
  ch2Keys: MeasurementKey[];
}

function F(n: number): string {
  if (!Number.isFinite(n)) return "---";
  if (Math.abs(n) < 0.001) return `${(n * 1e6).toFixed(0)}µ`;
  if (Math.abs(n) < 1)     return `${(n * 1e3).toFixed(1)}m`;
  return `${n.toFixed(2)}`;
}

function FF(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "---";
  if (n >= 1000) return `${(n / 1e3).toFixed(2)}kHz`;
  if (n >= 1)    return `${n.toFixed(1)}Hz`;
  return `${(n * 1e3).toFixed(1)}mHz`;
}

function FT(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "---";
  if (n < 1e-9) return `${(n * 1e12).toFixed(0)}ps`;
  if (n < 1e-6) return `${(n * 1e9).toFixed(0)}ns`;
  if (n < 1e-3) return `${(n * 1e6).toFixed(1)}µs`;
  if (n < 1)    return `${(n * 1e3).toFixed(1)}ms`;
  return `${n.toFixed(2)}s`;
}

function formatMeasurement(key: MeasurementKey, m: Measurements): string {
  switch (key) {
    case "vpp": return `Vpp=${F(m.vpp)}V`;
    case "dc": return `DC=${F(m.dc)}V`;
    case "vrms": return `RMS=${F(m.vrms)}V`;
    case "freq": return `F=${FF(m.freq)}`;
    case "period": return `T=${FT(m.period)}`;
    case "riseTime": return `Rise=${FT(m.riseTime)}`;
    case "fallTime": return `Fall=${FT(m.fallTime)}`;
    case "dutyCycle": return `Duty=${m.dutyCycle.toFixed(1)}%`;
    case "positiveWidth": return `+W=${FT(m.positiveWidth)}`;
    case "negativeWidth": return `-W=${FT(m.negativeWidth)}`;
  }
}

function ChannelReadout({ label, color, measurements, keys }: {
  label: string;
  color: string;
  measurements: Measurements;
  keys: MeasurementKey[];
}) {
  const textColor = color === "orange" ? "text-fob-orange" : "text-fob-blue";
  return (
    <div className="flex items-center gap-2">
      <span className={`font-bold text-[11px] shrink-0 ${textColor}`}>{label}</span>
      {keys.map((k) => (
        <span key={k} className="text-[11px] text-fob-text-dim font-mono shrink-0">
          {formatMeasurement(k, measurements)}
        </span>
      ))}
    </div>
  );
}

export function MeasurementBar({ ch1, ch2, ch1Keys, ch2Keys }: Props) {
  return (
    <div className="flex items-center gap-4 text-[11px] font-mono text-fob-text-dim border-t border-fob-border pt-1 pb-1 px-2 shrink-0 overflow-hidden select-none">
      <ChannelReadout label="CH1" color="orange" measurements={ch1} keys={ch1Keys} />
      <ChannelReadout label="CH2" color="blue" measurements={ch2} keys={ch2Keys} />
    </div>
  );
}
