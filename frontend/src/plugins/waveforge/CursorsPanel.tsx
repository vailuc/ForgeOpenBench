import { CollapsibleSection } from "./CollapsibleSection";

interface Cursor {
  t: number;
  v: number;
}

interface Props {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  cursorA: Cursor | null;
  cursorB: Cursor | null;
}

function F(n: number): string {
  if (!Number.isFinite(n)) return "---";
  if (Math.abs(n) < 1e-6) return `${(n * 1e9).toFixed(1)}ns`;
  if (Math.abs(n) < 1e-3) return `${(n * 1e6).toFixed(1)}µs`;
  if (Math.abs(n) < 1)    return `${(n * 1e3).toFixed(1)}ms`;
  return `${n.toFixed(3)}s`;
}

function V(n: number): string {
  if (!Number.isFinite(n)) return "---";
  if (Math.abs(n) < 0.001) return `${(n * 1e6).toFixed(0)}µV`;
  if (Math.abs(n) < 1)     return `${(n * 1e3).toFixed(1)}mV`;
  return `${n.toFixed(2)}V`;
}

export function CursorsPanel({ enabled, onToggle, cursorA, cursorB }: Props) {
  const dt = cursorA && cursorB ? Math.abs(cursorB.t - cursorA.t) : null;
  const dv = cursorA && cursorB ? Math.abs(cursorB.v - cursorA.v) : null;
  const invDt = dt && dt > 0 ? 1 / dt : null;

  return (
    <CollapsibleSection title="Cursors" defaultOpen={false}>
      <label className="flex items-center gap-1.5 text-[11px] text-fob-text font-bold mb-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-fob-orange"
        />
        Enable Cursors
        <span className="text-[10px] text-fob-text-dim font-normal">(click = A, shift+click = B)</span>
      </label>

      {cursorA && (
        <div className="text-[11px] text-fob-text mb-1">
          <span className="text-fob-orange font-bold">A</span>{" "}
          t={F(cursorA.t)} v={V(cursorA.v)}
        </div>
      )}
      {cursorB && (
        <div className="text-[11px] text-fob-text mb-1">
          <span className="text-fob-blue font-bold">B</span>{" "}
          t={F(cursorB.t)} v={V(cursorB.v)}
        </div>
      )}
      {dt != null && dv != null && (
        <div className="text-[11px] text-fob-text-dim font-mono border-t border-fob-border pt-1 mt-1">
          <div>ΔT={F(dt)}</div>
          <div>ΔV={V(dv)}</div>
          {invDt != null && <div>1/ΔT={invDt >= 1e3 ? `${(invDt / 1e3).toFixed(2)}kHz` : `${invDt.toFixed(1)}Hz`}</div>}
        </div>
      )}
    </CollapsibleSection>
  );
}
