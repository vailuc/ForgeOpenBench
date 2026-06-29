import type uPlot from "uplot";

function makeTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${h}${min}${s}`;
}

export function exportTraceCsv(
  plot: uPlot | null,
  seriesNames: string[],
  viewMode: "time" | "fft" | "xy" = "time"
): void {
  if (!plot || !plot.data || plot.data[0].length === 0) return;
  const xs = plot.data[0] as Float64Array | number[];
  const rows: string[] = [];
  const xLabel = viewMode === "fft" ? "frequency(hz)" : viewMode === "xy" ? "x" : "time(s)";
  const header = [xLabel, ...seriesNames].join(",");
  rows.push(header);
  const len = xs.length;
  for (let i = 0; i < len; i++) {
    const t = Array.isArray(xs) ? xs[i] : xs[i];
    const cells: (string | number)[] = [t.toExponential(6)];
    for (let s = 1; s < plot.data.length; s++) {
      const ys = plot.data[s] as Float64Array | number[];
      const v = ys && ys.length > i ? (Array.isArray(ys) ? ys[i] : ys[i]) : "";
      cells.push(typeof v === "number" ? v.toExponential(6) : "");
    }
    rows.push(cells.join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `scope-trace-${makeTimestamp()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPlotPng(plot: uPlot | null, filename?: string): void {
  if (!plot) return;
  const canvas = plot.root.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `scope-screen-${makeTimestamp()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
