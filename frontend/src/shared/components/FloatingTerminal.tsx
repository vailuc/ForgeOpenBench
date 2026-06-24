import { useRef, useState, useEffect } from "react";
import { SystemTerminal } from "./SystemTerminal";

interface FloatingTerminalProps {
  open: boolean;
  onClose: () => void;
}

export function FloatingTerminal({ open, onClose }: FloatingTerminalProps) {
  const [pos, setPos] = useState({ x: 100, y: 100 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      setPos({
        x: Math.max(10, Math.min(window.innerWidth - 420, e.clientX - dragStart.current.x)),
        y: Math.max(50, Math.min(window.innerHeight - 240, e.clientY - dragStart.current.y)),
      });
    };
    const onUp = () => setDragging(false);
    if (dragging) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  if (!open) return null;

  return (
    <div
      style={{ top: pos.y, left: pos.x }}
      className="absolute w-[400px] h-[220px] bg-fob-surface border-2 border-fob-orange/30 rounded-lg shadow-2xl shadow-black/80 flex flex-col overflow-hidden backdrop-blur-md z-40 select-none"
    >
      {/* Drag handle */}
      <div
        onMouseDown={(e) => {
          setDragging(true);
          dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
        }}
        className="bg-fob-bg px-3 h-7 text-xs text-fob-orange flex justify-between items-center shrink-0 cursor-move border-b border-fob-border"
      >
        <div className="flex items-center gap-2 font-mono font-bold tracking-wider">
          <span className="text-fob-orange/60">↔</span>
          SYSTEM TERMINAL
        </div>
        <button
          onClick={onClose}
          className="text-fob-text-dim hover:text-fob-orange transition-colors px-1"
        >
          [x]
        </button>
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden">
        <SystemTerminal isOpen={open} />
      </div>
    </div>
  );
}
