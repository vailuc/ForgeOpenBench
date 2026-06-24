interface StatusItem {
  label: string;
  color: string;
  active: boolean;
}

interface StatusBarProps {
  items: StatusItem[];
}

export function StatusBar({ items }: StatusBarProps) {
  return (
    <div className="flex items-center gap-2 bg-fob-bg px-2 pb-1 h-7 flex-shrink-0">
      {items.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5 rounded bg-fob-surface px-2 py-1">
          <span className={`h-2 w-2 rounded-full ${s.color} ${s.active ? "animate-pulse" : ""}`} />
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-fob-text-dim">
            {s.label}
          </span>
        </div>
      ))}
      <div className="flex-1" />
      <div className="h-1 w-24 rounded bg-fob-orange" />
    </div>
  );
}
