import { useEffect, useRef, useState, useCallback } from "react";

interface HistoryPoint {
  timestamp: number;
  value: number;
  display: string;
  delta: number | null;
}

const HISTORY_SIZE = 300;
const TICKER_SIZE = 12;

export function useMeterHistory() {
  const historyRef = useRef<HistoryPoint[]>([]);
  const [ticker, setTicker] = useState<HistoryPoint[]>([]);
  const rafRef = useRef<number>(0);
  const lastPushRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const push = useCallback((value: number | null, display: string) => {
    if (value === null || !Number.isFinite(value)) return;
    const now = Date.now();
    // Throttle: max 1 push per 100ms
    if (now - lastPushRef.current < 100) return;
    lastPushRef.current = now;

    const h = historyRef.current;
    const prev = h.length > 0 ? h[h.length - 1] : null;
    const delta = prev ? value - prev.value : null;
    h.push({ timestamp: now, value, display, delta });
    if (h.length > HISTORY_SIZE) h.shift();
  }, []);

  const reset = useCallback(() => {
    historyRef.current = [];
    lastPushRef.current = 0;
    setTicker([]);
    // Clear canvas
    const c = canvasRef.current;
    if (c) {
      const ctx = c.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    }
  }, []);

  // Throttled ticker update
  useEffect(() => {
    const id = setInterval(() => {
      const h = historyRef.current;
      if (h.length === 0) return;
      setTicker(h.slice(-TICKER_SIZE));
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Canvas draw loop
  useEffect(() => {
    const hexToRgba = (hex: string, alpha: number) => {
      const clean = hex.replace("#", "");
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    const getCssColor = (name: string, fallback: string, alpha = 1) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const color = raw || fallback;
      if (color.startsWith("#")) return hexToRgba(color, alpha);
      if (color.startsWith("rgba(")) return color;
      if (color.startsWith("rgb(")) return color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
      return color;
    };

    const draw = () => {
      const c = canvasRef.current;
      if (!c) { rafRef.current = requestAnimationFrame(draw); return; }
      const ctx = c.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }

      const w = c.width;
      const h = c.height;
      const data = historyRef.current;
      if (data.length < 2) {
        ctx.clearRect(0, 0, w, h);
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Y-axis auto-scale with padding
      const values = data.map((d) => d.value);
      let min = Math.min(...values);
      let max = Math.max(...values);
      const pad = (max - min) * 0.1 || Math.abs(max) * 0.1 || 1;
      min -= pad;
      max += pad;
      const range = max - min || 1;

      ctx.clearRect(0, 0, w, h);

      const accentColor = getCssColor("--fob-accent", "#FF9900");
      const textColor = getCssColor("--fob-text", "#E8E8EC", 0.35);
      const gridColor = getCssColor("--fob-border", "rgba(255,255,255,0.06)");

      // Grid line at zero
      const zeroY = h - ((0 - min) / range) * h;
      if (zeroY >= 0 && zeroY <= h) {
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        ctx.lineTo(w, zeroY);
        ctx.stroke();
      }

      // Sparkline
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      data.forEach((pt, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - ((pt.value - min) / range) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Min/max labels
      ctx.fillStyle = textColor;
      ctx.font = "8px monospace";
      ctx.fillText(max.toExponential(1), 2, 10);
      ctx.fillText(min.toExponential(1), 2, h - 2);

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return { push, reset, ticker, canvasRef, historyRef };
}

export function TickerTape({ entries }: { entries: HistoryPoint[] }) {
  return (
    <div className="h-full flex flex-col justify-end gap-0.5 overflow-hidden select-none">
      {entries.map((pt, i) => {
        const opacity = 0.3 + (i / entries.length) * 0.7;
        const deltaStr = pt.delta !== null
          ? (pt.delta >= 0 ? `+${pt.delta.toExponential(1)}` : pt.delta.toExponential(1))
          : "";
        return (
          <div
            key={pt.timestamp}
            className={`text-[9px] font-mono leading-tight whitespace-nowrap ${i === entries.length - 1 ? "text-fob-orange" : "text-fob-text-dim"}`}
            style={{ opacity }}
            title={new Date(pt.timestamp).toLocaleTimeString()}
          >
            <span>{pt.display}</span>
            {deltaStr && <span className="ml-1 text-[8px] opacity-50">{deltaStr}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function SparklineCanvas({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  return (
    <canvas
      ref={canvasRef}
      width={120}
      height={80}
      className="w-full h-full rounded border border-fob-border/30 bg-fob-bg/50"
    />
  );
}
