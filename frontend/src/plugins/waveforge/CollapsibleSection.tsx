import { useState } from "react";

interface Props {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-fob-border rounded bg-fob-surface">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-fob-orange hover:bg-fob-border/30 rounded-t transition-colors"
      >
        <span>{title}</span>
        <span className="text-fob-text-dim">{open ? "▼" : "▶"}</span>
      </button>
      {open && <div className="p-2 pt-1 flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}
