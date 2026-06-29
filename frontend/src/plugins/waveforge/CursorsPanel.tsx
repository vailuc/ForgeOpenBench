import { CollapsibleSection } from "./CollapsibleSection";
import type { Cursor } from "./scopeTypes";

interface Props {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  cursorA: Cursor | null;
  cursorB: Cursor | null;
  viewMode?: "time" | "fft" | "xy";
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

export function CursorsPanel({ enabled, onToggle, cursorA, cursorB, viewMode = "time" }: Props) {
  const isXy = viewMode === "xy";
  const dx = cursorA && cursorB ? Math.abs(cursorB.x - cursorA.x) : null;
  const dy = cursorA && cursorB ? Math.abs(cursorB.y - cursorA.y) : null;
  const invDt = !isXy && dx && dx > 0 ? 1 / dx : null;

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
          {isXy ? `x=${V(cursorA.x)} y=${V(cursorA.y)}` : `t=${F(cursorA.x)} v=${V(cursorA.y)}`}
        </div>
      )}
      {cursorB && (
        <div className="text-[11px] text-fob-text mb-1">
          <span className="text-fob-blue font-bold">B</span>{" "}
          {isXy ? `x=${V(cursorB.x)} y=${V(cursorB.y)}` : `t=${F(cursorB.x)} v=${V(cursorB.y)}`}
        </div>
      )}
      {dx != null && dy != null && (
        <div className="text-[11px] text-fob-text-dim font-mono border-t border-fob-border pt-1 mt-1">
          {isXy ? (
            <>
              <div>ΔX={V(dx)}</div>
              <div>ΔY={V(dy)}</div>
            </>
          ) : (
            <>
              <div>ΔT={F(dx)}</div>
              <div>ΔV={V(dy)}</div>
              {invDt != null && <div>1/ΔT={invDt >= 1e3 ? `${(invDt / 1e3).toFixed(2)}kHz` : `${invDt.toFixed(1)}Hz`}</div>}
            </>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}
