import { useEffect, useRef, useCallback, useState } from "react";
import { getSharedTransport } from "./sharedTransport";
import { StatusService } from "./StatusService";
import { formatSi } from "./types";
import { StatusServiceUuids } from "./uuids";
import type { PluginBus } from "../types";
import { useLogger } from "./useLogger";
import { toast } from "../../shared/hooks/useToastStore";
import { meterStateRef } from "./sharedMeterStore";

interface LoggerViewProps {
  bus?: PluginBus;
  isActive?: boolean;
}

export function LoggerView({ bus: _bus, isActive: _isActive }: LoggerViewProps) {
  const {
    isRunning,
    isPaused,
    stats,
    samples,
    lastSample,
    start,
    stop,
    pause,
    resume,
    reset,
    exportCsv,
    exportJson,
    download,
    saveToServer,
  } = useLogger();

  const buttonUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});

  // Auto-start: Logger mirrors Meter's data stream
  useEffect(() => {
    start();
    return () => { stop(); };
  }, [start, stop]);

  const mode = lastSample?.mode ?? "DC Voltage";
  const unit = lastSample?.unit ?? "V";

  // Poll shared meter state (REL / TARE / HOLD) for icon display
  const [meterState, setMeterState] = useState({ rel: false, tare: false, hold: false });
  useEffect(() => {
    const id = setInterval(() => {
      const s = meterStateRef.current;
      setMeterState((prev) => (prev.rel !== s.rel || prev.tare !== s.tare || prev.hold !== s.hold) ? { ...s } : prev);
    }, 200);
    return () => clearInterval(id);
  }, []);

  const handleExportCsv = useCallback(() => {
    const csv = exportCsv();
    if (!csv) { toast.warning("No data to export"); return; }
    download(csv, `logger_${Date.now()}.csv`, "text/csv");
    toast.success("CSV downloaded");
  }, [exportCsv, download]);

  const handleExportJson = useCallback(() => {
    const json = exportJson();
    if (!json) { toast.warning("No data to export"); return; }
    download(json, `logger_${Date.now()}.json`, "application/json");
    toast.success("JSON downloaded");
  }, [exportJson, download]);

  const handleSave = useCallback(async () => {
    const result = await saveToServer();
    if (!result) { toast.warning("No data to save"); return; }
    if (result.server) {
      toast.success("Saved to server");
    } else {
      toast.success("Saved locally (server offline)");
    }
  }, [saveToServer]);

  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  // Hardware button: save current logger reading on release
  useEffect(() => {
    const t = getSharedTransport();
    if (!t || !t.isConnected) return;
    let active = true;
    (async () => {
      try {
        let statusUuid: string = StatusServiceUuids.pokitPro;
        try { await t.readCharacteristic(statusUuid, StatusServiceUuids.characteristics.status); }
        catch { statusUuid = StatusServiceUuids.pokitMeter; }
        const ss = new StatusService(t, statusUuid);
        const unsub = await ss.onButtonPress((raw) => {
          const isRelease = raw.length >= 2 && raw[1] === 0x00;
          if (isRelease && lastSample) void handleSaveRef.current();
        });
        if (active) buttonUnsubRef.current = unsub;
        else unsub();
      } catch { /* ignore */ }
    })();
    return () => { active = false; buttonUnsubRef.current?.(); buttonUnsubRef.current = null; };
  }, [lastSample]);

  const isRecording = isRunning && !isPaused;

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Header / Controls */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className={`text-xs font-mono uppercase tracking-wider ${isRecording ? "text-fob-orange animate-pulse" : "text-fob-text-dim"}`}>
            {isRecording ? "● REC" : isRunning && isPaused ? "⏸ PAUSED" : "○ IDLE"}
          </span>
          {lastSample && (
            <span className="text-xs font-mono text-fob-text-dim">
              {formatSi(lastSample.value, unit)} · {stats?.count ?? 0} samples
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isRunning ? (
            <button
              onClick={start}
              className="px-3 py-1 rounded text-xs font-mono bg-fob-green/20 text-fob-green border border-fob-green/30 hover:bg-fob-green/30"
            >
              Start
            </button>
          ) : (
            <>
              {isPaused ? (
                <button
                  onClick={resume}
                  className="px-3 py-1 rounded text-xs font-mono bg-fob-green/20 text-fob-green border border-fob-green/30 hover:bg-fob-green/30"
                >
                  Resume
                </button>
              ) : (
                <button
                  onClick={pause}
                  className="px-3 py-1 rounded text-xs font-mono bg-fob-orange/20 text-fob-orange border border-fob-orange/30 hover:bg-fob-orange/30"
                >
                  Pause
                </button>
              )}
              <button
                onClick={stop}
                className="px-3 py-1 rounded text-xs font-mono bg-fob-red/20 text-fob-red border border-fob-red/30 hover:bg-fob-red/30"
              >
                Stop
              </button>
            </>
          )}
          <button
            onClick={reset}
            disabled={!stats && !lastSample}
            className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border disabled:opacity-30 hover:text-fob-orange"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Stats Panel */}
      {stats && (
        <div className="grid grid-cols-4 gap-2 shrink-0">
          <StatBox label="Samples" value={stats.count.toString()} />
          <StatBox label="Duration" value={`${(stats.durationMs / 1000).toFixed(1)}s`} />
          <StatBox label="Rate" value={`${stats.rateHz.toFixed(1)} Hz`} />
          <StatBox label="SNR" value={stats.snrDb !== null ? `${stats.snrDb.toFixed(1)} dB` : "—"} />
          <StatBox label="Min" value={formatSi(stats.min, unit)} />
          <StatBox label="Max" value={formatSi(stats.max, unit)} />
          <StatBox label="Avg" value={formatSi(stats.avg, unit)} />
          <StatBox label="Span" value={formatSi(stats.span, unit)} />
        </div>
      )}

      {/* Live Value */}
      {lastSample && (
        <div className="shrink-0 rounded border border-fob-border bg-fob-surface p-3 flex items-center justify-center">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              {meterState.hold && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-fob-orange/30 text-fob-text border border-fob-orange/40">HOLD</span>}
              {meterState.rel && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-fob-orange/30 text-fob-text border border-fob-orange/40">REL</span>}
              {meterState.tare && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-fob-green/30 text-fob-text border border-fob-green/40">TARE</span>}
            </div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-fob-text-dim mb-1">
              {mode}
            </div>
            <div className="font-mono text-2xl text-fob-green">
              {formatSi(lastSample.value, unit)}
            </div>
          </div>
        </div>
      )}

      {/* Mini sparkline placeholder */}
      <div className="flex-1 min-h-0 rounded border border-fob-border bg-fob-surface p-2 relative overflow-hidden">
        <div className="text-[10px] font-mono text-fob-text-dim absolute top-2 left-2">Live Plot</div>
        <LoggerSparkline samples={samples} />
      </div>

      {/* Export Controls */}
      <div className="shrink-0 flex gap-2">
        <button
          onClick={handleExportCsv}
          disabled={!stats}
          className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border disabled:opacity-30 hover:text-fob-orange"
        >
          Export CSV
        </button>
        <button
          onClick={handleExportJson}
          disabled={!stats}
          className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border disabled:opacity-30 hover:text-fob-orange"
        >
          Export JSON
        </button>
        <button
          onClick={handleSave}
          disabled={!stats}
          className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border disabled:opacity-30 hover:text-fob-orange"
        >
          Save
        </button>
        <button
          onClick={async () => {
            const csv = exportCsv();
            if (!csv) { toast.warning("No data to export"); return; }
            const payload = { plugin: "pocketforge", type: "logger_csv", name: `logger_${new Date().toISOString()}`, timestamp: Date.now(), csv };
            try {
              const resp = await fetch("/api/v1/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              toast.success("CSV uploaded to server");
            } catch {
              toast.error("Upload failed — downloading locally");
              download(csv, `logger_${Date.now()}.csv`, "text/csv");
            }
          }}
          disabled={!stats}
          className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border disabled:opacity-30 hover:text-fob-orange"
        >
          Upload CSV
        </button>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-fob-border bg-fob-surface p-2 text-center">
      <div className="text-[10px] font-mono uppercase tracking-wider text-fob-text-dim">{label}</div>
      <div className="font-mono text-sm text-fob-text">{value}</div>
    </div>
  );
}

function LoggerSparkline({ samples }: { samples: { timestamp: number; value: number; unit: string; mode: string }[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || samples.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = 4;

    const visible = samples.slice(-200);
    const vals = visible.map((s) => s.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;

    ctx.clearRect(0, 0, w, h);

    const zeroY = max > 0 && min < 0 ? pad + (max / span) * (h - pad * 2) : null;
    if (zeroY !== null) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(w, zeroY);
      ctx.stroke();
    }

    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < visible.length; i++) {
      const x = (i / (visible.length - 1)) * w;
      const y = pad + ((max - visible[i].value) / span) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(249, 115, 22, 0.1)";
    ctx.fill();
  }, [samples]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(parent);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div ref={parentRef} className="h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ display: samples.length < 2 ? "none" : "block" }}
      />
    </div>
  );
}
