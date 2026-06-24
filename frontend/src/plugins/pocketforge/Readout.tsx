interface ReadoutProps {
  value: string;
  label: string;
  sub?: string;
  gated?: boolean;
}

export function Readout({ value, label, sub }: ReadoutProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-4">
      <div className="text-[10px] font-mono uppercase tracking-wider text-fob-text-dim">{label}</div>
      <div className="font-mono text-5xl font-bold tracking-tight text-fob-green">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] font-mono text-fob-text-dim h-4">{sub}</div>
      )}
    </div>
  );
}
