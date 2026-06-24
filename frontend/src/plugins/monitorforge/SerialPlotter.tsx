import { useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface SerialPlotterProps {
  lines: string[];
  height?: number;
}

export interface SerialPlotterRef {
  exportImage: () => string | null;
}

const COLORS = ["#00e5a0", "#f59e0b", "#38bdf8", "#f472b6", "#a78bfa", "#fb923c"];

function parseNumbers(line: string): number[] | null {
  const parts = line.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length === 0 || parts.some((n) => isNaN(n))) return null;
  return parts;
}

function buildPlotData(lines: string[]) {
  const xs: number[] = [];
  const series: number[][] = [];
  let sampleIdx = 0;

  for (const line of lines) {
    const nums = parseNumbers(line);
    if (!nums) continue;

    xs.push(sampleIdx++);
    for (let i = 0; i < nums.length; i++) {
      if (!series[i]) series[i] = [];
      series[i].push(nums[i]);
    }
  }

  const maxLen = xs.length;
  for (const s of series) {
    while (s.length < maxLen) {
      s.push(NaN);
    }
  }

  return { xs, series };
}

export const SerialPlotter = forwardRef<SerialPlotterRef, SerialPlotterProps>(function SerialPlotter({ lines, height = 240 }, ref) {
  const innerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const data = useMemo(() => buildPlotData(lines), [lines]);

  useImperativeHandle(ref, () => ({
    exportImage: () => {
      const canvas = innerRef.current?.querySelector("canvas");
      return canvas?.toDataURL("image/png") ?? null;
    },
  }));

  useEffect(() => {
    if (!innerRef.current) return;

    const opts: uPlot.Options = {
      width: innerRef.current.clientWidth,
      height,
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        { stroke: "#a3a3a3", grid: { stroke: "#1a3a3a" }, ticks: { stroke: "#404040" } },
        { stroke: "#a3a3a3", grid: { stroke: "#1a3a3a" }, ticks: { stroke: "#404040" } },
      ],
      series: [
        {},
        ...data.series.map((_, i) => ({
          label: `S${i}`,
          stroke: COLORS[i % COLORS.length],
          width: 2,
          points: { show: false },
        })),
      ],
      cursor: {
        drag: { setScale: false },
      },
    };

    const plot = new uPlot(opts, [data.xs, ...data.series], innerRef.current);
    plotRef.current = plot;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        if (width > 0) plot.setSize({ width, height });
      }
    });
    ro.observe(innerRef.current);

    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [height, data.series.length]);

  useEffect(() => {
    if (plotRef.current) {
      plotRef.current.setData([data.xs, ...data.series]);
    }
  }, [data]);

  if (data.xs.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-fob-text-dim text-[10px] font-mono">
        Waiting for numeric data (CSV format: 25,1023,…)
      </div>
    );
  }

  return <div ref={innerRef} className="w-full h-full" />;
});
