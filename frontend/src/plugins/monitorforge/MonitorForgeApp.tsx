import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "lucide-react";
import type { PluginBus } from "../types";
import { wsUrl } from "../../core/ws_url";
import { globalBus } from "../../core/global_bus";
import { SerialPlotter } from "./SerialPlotter";
import type { SerialPlotterRef } from "./SerialPlotter";
import { useSettingsStore } from "../../core/settings_store";
import { toast } from "../../shared/hooks/useToastStore";
import { saveToProject, exportTerminalText, exportPlotterCsv, dataUrlToBase64 } from "./export";

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const LS_BAUD = (id: string) => `fob.monitorforge.${id}.baud`;
const LS_HEX = (id: string) => `fob.monitorforge.${id}.hex`;
const LS_VIEW = (id: string) => `fob.monitorforge.${id}.view`;

type LayoutCount = 1 | 2 | 3;
type ViewMode = "terminal" | "plotter";

export interface SerialLine {
  id: number;
  ts: string;
  text: string;
  dir: "rx" | "tx" | "sys";
}

interface PaneState {
  id: string;
  port: string;
  baud: number;
  hexMode: boolean;
  view: ViewMode;
  lines: SerialLine[];
  sendBuf: string;
  connected: boolean;
  connecting: boolean;
}

interface MonitorForgeAppProps {
  bus: PluginBus;
}

function usePorts() {
  const [ports, setPorts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  const rescan = useCallback(() => {
    setScanning(true);
    fetch("/api/v1/serial/ports")
      .then((r) => r.ok ? r.json() : { ports: [] })
      .then((d) => setPorts((d.ports as { device: string }[]).map((p) => p.device)))
      .catch(() => {})
      .finally(() => setScanning(false));
  }, []);

  useEffect(() => {
    rescan();
    const id = setInterval(() => {
      fetch("/api/v1/serial/ports")
        .then((r) => r.ok ? r.json() : { ports: [] })
        .then((d) => setPorts((d.ports as { device: string }[]).map((p) => p.device)))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [rescan]);

  return { ports, rescan, scanning };
}

const PANE_IDS = ["monitor-0", "monitor-1", "monitor-2"] as const;
const EMPTY_CFG: Record<string, unknown> = {};

function makePane(id: string, cfg: Record<string, unknown>): PaneState {
  const defaultBaud = Number(cfg.defaultBaud ?? 115200);
  const defaultMode = cfg.defaultMode === "plotter" ? "plotter" : "terminal";
  const savedView = localStorage.getItem(LS_VIEW(id));
  return {
    id,
    port: "",
    baud: parseInt(localStorage.getItem(LS_BAUD(id)) ?? String(defaultBaud), 10),
    hexMode: localStorage.getItem(LS_HEX(id)) === "1",
    view: (savedView === "plotter" ? "plotter" : savedView === "terminal" ? "terminal" : defaultMode) as ViewMode,
    lines: [],
    sendBuf: "",
    connected: false,
    connecting: false,
  };
}

function SerialPortPane({
  pane,
  ports,
  showTimestamps,
  onUpdate,
}: {
  pane: PaneState;
  ports: string[];
  showTimestamps: boolean;
  onUpdate: (patch: Partial<PaneState>) => void;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const rxBuf = useRef("");
  const counterRef = useRef(0);
  const linesRef = useRef<SerialLine[]>(pane.lines);
  linesRef.current = pane.lines;
  const hexModeRef = useRef(pane.hexMode);
  hexModeRef.current = pane.hexMode;
  const bottomRef = useRef<HTMLDivElement>(null);
  const plotterRef = useRef<SerialPlotterRef>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pane.lines.length]);

  useEffect(() => {
    localStorage.setItem(LS_BAUD(pane.id), String(pane.baud));
  }, [pane.id, pane.baud]);

  useEffect(() => {
    localStorage.setItem(LS_HEX(pane.id), pane.hexMode ? "1" : "0");
  }, [pane.id, pane.hexMode]);

  useEffect(() => {
    localStorage.setItem(LS_VIEW(pane.id), pane.view);
  }, [pane.id, pane.view]);

  useEffect(() => () => { wsRef.current?.close(); }, []);

  // Auto-select the first available port if none is currently selected.
  useEffect(() => {
    if (!pane.port && ports.length > 0 && !pane.connected) {
      onUpdate({ port: ports[0] });
    }
  }, [pane.port, ports, pane.connected, onUpdate]);

  const addLine = useCallback((text: string, dir: SerialLine["dir"]) => {
    const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
    const line: SerialLine = { id: ++counterRef.current, ts, text, dir };
    onUpdate({ lines: [...linesRef.current.slice(-499), line] });
  }, [onUpdate]);

  const connect = useCallback(() => {
    if (!pane.port || pane.connected) return;
    onUpdate({ connecting: true });
    const ws = new WebSocket(wsUrl(`/api/v1/serial/stream?port=${encodeURIComponent(pane.port)}&baud=${pane.baud}`, 8000));
    wsRef.current = ws;

    ws.onopen = () => {
      onUpdate({ connected: true, connecting: false });
      addLine(`Connected to ${pane.port} @ ${pane.baud}`, "sys");
      globalBus.emit("monitorforge.serial.status", { connected: true, port: pane.port, paneId: pane.id });
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      rxBuf.current += e.data;
      const parts = rxBuf.current.split("\n");
      rxBuf.current = parts.pop() ?? "";
      parts.forEach((raw) => {
        const text = hexModeRef.current
          ? Array.from(raw).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ")
          : raw;
        addLine(text, "rx");
      });
    };
    ws.onclose = () => {
      onUpdate({ connected: false, connecting: false });
      addLine("Disconnected", "sys");
      globalBus.emit("monitorforge.serial.status", { connected: false, port: pane.port, paneId: pane.id });
    };
    ws.onerror = () => {
      onUpdate({ connected: false, connecting: false });
      addLine("Connection error", "sys");
    };
  }, [pane.port, pane.baud, pane.connected, pane.id, addLine, onUpdate]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const send = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !pane.sendBuf) return;
    wsRef.current.send(pane.sendBuf + "\n");
    addLine(pane.sendBuf, "tx");
    onUpdate({ sendBuf: "" });
  }, [pane.sendBuf, pane.connected, addLine, onUpdate]);

  const lineColor = (dir: SerialLine["dir"]) => {
    if (dir === "rx") return "text-fob-text";
    if (dir === "tx") return "text-fob-orange opacity-70";
    return "text-fob-text-dim italic";
  };
  const dirIcon = (dir: SerialLine["dir"]) => {
    if (dir === "rx") return <span className="text-fob-green font-bold">←</span>;
    if (dir === "tx") return <span className="text-fob-orange font-bold">→</span>;
    return <span className="text-fob-text-dim">·</span>;
  };

  const projectName = useSettingsStore((s) => (s.config?.workspace as Record<string, string> | undefined)?.active_project ?? "");

  const handleExportTerminal = useCallback(async () => {
    const text = exportTerminalText(pane.lines);
    if (!text) return;
    const filename = `monitorforge_${pane.id}_${Date.now()}.txt`;
    const result = await saveToProject(projectName, `captures/serial/${filename}`, text, filename);
    if (result.ok) toast.success(`Saved ${filename}`);
    else if (result.fallback) toast.info(`Downloaded ${filename}`);
    else toast.error(`Failed to save ${filename}`);
  }, [pane.lines, pane.id, projectName]);

  const handleExportPlotterCsv = useCallback(async () => {
    const rxLines = pane.lines.filter((l) => l.dir === "rx").map((l) => l.text);
    const csv = exportPlotterCsv(rxLines);
    if (!csv) return;
    const filename = `monitorforge_plot_${pane.id}_${Date.now()}.csv`;
    const result = await saveToProject(projectName, `captures/serial/${filename}`, csv, filename);
    if (result.ok) toast.success(`Saved ${filename}`);
    else if (result.fallback) toast.info(`Downloaded ${filename}`);
    else toast.error(`Failed to save ${filename}`);
  }, [pane.lines, pane.id, projectName]);

  const handleExportPlotterImage = useCallback(async () => {
    const dataUrl = plotterRef.current?.exportImage();
    if (!dataUrl) return;
    const parsed = dataUrlToBase64(dataUrl);
    if (!parsed) return;
    const filename = `monitorforge_plot_${pane.id}_${Date.now()}.png`;
    const result = await saveToProject(projectName, `captures/serial/${filename}`, parsed, filename);
    if (result.ok) toast.success(`Saved ${filename}`);
    else if (result.fallback) toast.info(`Downloaded ${filename}`);
    else toast.error(`Failed to save ${filename}`);
  }, [pane.id, projectName]);

  return (
    <div className="flex flex-col h-full border border-fob-border rounded-lg overflow-hidden bg-fob-surface">
      {/* Pane toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-fob-border bg-fob-bg flex-shrink-0 flex-wrap">
        <select
          value={pane.port}
          onChange={(e) => onUpdate({ port: e.target.value })}
          disabled={pane.connected}
          className="rounded bg-fob-surface border border-fob-border text-[10px] font-mono text-fob-text px-1.5 py-0.5 disabled:opacity-50 max-w-[130px] truncate"
        >
          {ports.length === 0 && <option value="">No ports</option>}
          {ports.length > 0 && <option value="">Select port…</option>}
          {ports.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={pane.baud}
          onChange={(e) => onUpdate({ baud: Number(e.target.value) })}
          disabled={pane.connected}
          className="rounded bg-fob-surface border border-fob-border text-[10px] font-mono text-fob-text px-1.5 py-0.5 disabled:opacity-50"
        >
          {BAUD_RATES.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <button
          onClick={pane.connected ? disconnect : connect}
          disabled={pane.connecting || !pane.port}
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors disabled:opacity-40 ${
            pane.connected
              ? "bg-fob-red/20 text-fob-red border-fob-red/40 hover:bg-fob-red/30"
              : "bg-fob-orange/20 text-fob-orange border-fob-orange/40 hover:bg-fob-orange/30"
          }`}
        >
          {pane.connecting ? "…" : pane.connected ? "Disconnect" : "Connect"}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => onUpdate({ view: "terminal" })}
          disabled={pane.view === "terminal"}
          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors disabled:opacity-40 ${
            pane.view === "terminal"
              ? "bg-fob-orange text-fob-accent-text border-fob-orange"
              : "text-fob-text-dim border-fob-border hover:text-fob-text hover:bg-fob-bg"
          }`}
        >Terminal</button>
        <button
          onClick={() => onUpdate({ view: "plotter" })}
          disabled={pane.view === "plotter"}
          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors disabled:opacity-40 ${
            pane.view === "plotter"
              ? "bg-fob-orange text-fob-accent-text border-fob-orange"
              : "text-fob-text-dim border-fob-border hover:text-fob-text hover:bg-fob-bg"
          }`}
        >Plotter</button>
        <button
          onClick={() => onUpdate({ hexMode: !pane.hexMode })}
          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors ${
            pane.hexMode ? "bg-fob-orange text-fob-accent-text border-fob-orange" : "text-fob-text-dim border-fob-border hover:text-fob-text"
          }`}
        >HEX</button>
        <button onClick={() => onUpdate({ lines: [] })} className="text-[10px] font-mono text-fob-text-dim hover:text-fob-red transition-colors">Clear</button>
        {pane.view === "terminal" ? (
          <button
            onClick={handleExportTerminal}
            disabled={pane.lines.length === 0}
            className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors disabled:opacity-40"
          >Export</button>
        ) : (
          <>
            <button
              onClick={handleExportPlotterCsv}
              disabled={pane.lines.filter((l) => l.dir === "rx").length === 0}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors disabled:opacity-40"
            >CSV</button>
            <button
              onClick={handleExportPlotterImage}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors"
            >PNG</button>
          </>
        )}
      </div>

      {/* Content: terminal or plotter */}
      {pane.view === "plotter" ? (
        <div className="flex-1 overflow-hidden bg-fob-bg p-1">
          <SerialPlotter ref={plotterRef} lines={pane.lines.filter((l) => l.dir === "rx").map((l) => l.text)} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] bg-fob-bg">
          {pane.lines.length === 0 && (
            <div className="text-fob-text-dim py-6 text-center text-[10px]">
              {pane.port ? "Connected — waiting for data" : "Select a port and connect"}
            </div>
          )}
          {pane.lines.map((l) => (
            <div key={l.id} className={`flex gap-2 py-[1px] border-b border-fob-border/10 ${lineColor(l.dir)}`}>
              {showTimestamps && <span className="flex-shrink-0 w-16 text-fob-text-dim text-[9px]">{l.ts}</span>}
              <span className="flex-shrink-0 w-3">{dirIcon(l.dir)}</span>
              <span className="break-all">{l.text}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Send bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-t border-fob-border bg-fob-bg flex-shrink-0">
        <input
          value={pane.sendBuf}
          onChange={(e) => onUpdate({ sendBuf: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder={pane.connected ? "Send + Enter" : "Not connected"}
          disabled={!pane.connected}
          className="flex-1 rounded bg-fob-surface border border-fob-border text-[11px] font-mono text-fob-text px-2 py-0.5 placeholder:text-fob-text-dim disabled:opacity-40 outline-none focus:border-fob-orange transition-colors"
        />
        <button
          onClick={send}
          disabled={!pane.connected || !pane.sendBuf}
          className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-fob-orange/20 text-fob-orange border border-fob-orange/40 hover:bg-fob-orange/30 transition-colors disabled:opacity-40"
        >Send</button>
      </div>
    </div>
  );
}

export function MonitorForgeApp({ bus: _bus }: MonitorForgeAppProps) {
  const [layout, setLayout] = useState<LayoutCount>(1);
  const cfg = useSettingsStore((s) => (s.config?.monitorforge as Record<string, unknown> | undefined) ?? EMPTY_CFG);
  const [panes, setPanes] = useState<PaneState[]>(() => PANE_IDS.map((id) => makePane(id, cfg)));
  const { ports, rescan, scanning } = usePorts();
  const showTimestamps = cfg.showTimestamps !== false;

  const updatePane = useCallback((idx: number, patch: Partial<PaneState>) => {
    setPanes((prev) => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
  }, []);

  const activePanes = panes.slice(0, layout);

  return (
    <div className="flex flex-col h-full bg-fob-bg text-fob-text">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 border-b border-fob-border bg-fob-surface px-3 flex-shrink-0"
        style={{ height: '53px' }}
      >
        <Terminal size={14} className="text-fob-yellow" />
        <span className="text-xs font-bold uppercase tracking-wider text-fob-yellow">MonitorForge</span>
        <span className="text-[10px] text-fob-text-dim font-mono ml-1">Serial / UART Monitor</span>

        <div className="flex items-center gap-1.5 ml-3">
          <button
            onClick={rescan}
            disabled={scanning}
            className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg disabled:opacity-40 transition-colors"
          >
            {scanning ? "…" : "Rescan"}
          </button>
          <span className="text-[9px] font-mono text-fob-text-dim">{ports.length} port{ports.length !== 1 ? "s" : ""} found</span>
        </div>

        <div className="ml-3 flex gap-1">
          {([1, 2, 3] as LayoutCount[]).map((l) => (
            <button
              key={l}
              onClick={() => setLayout(l)}
              className={`min-w-[28px] rounded px-2 py-0.5 text-[10px] font-bold transition-colors ${
                layout === l
                  ? "bg-fob-yellow text-fob-accent-text"
                  : "bg-fob-border text-fob-text-dim hover:text-fob-text"
              }`}
            >{l}</button>
          ))}
        </div>

        {/* Active connection dots */}
        <div className="flex items-center gap-2 ml-2">
          {activePanes.map((pane) => (
            <div key={pane.id} className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full flex-shrink-0 ${pane.connected ? "bg-fob-green animate-pulse" : "bg-fob-border"}`} />
              <span className="text-[9px] font-mono text-fob-text-dim truncate max-w-[80px]">
                {pane.connected ? pane.port : "offline"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Pane area */}
      <div className="flex flex-1 gap-1 overflow-hidden p-1 min-h-0">
        {activePanes.map((pane, idx) => (
          <div key={pane.id} className="flex-1 min-w-0 min-h-0">
            <SerialPortPane
              pane={pane}
              ports={ports}
              showTimestamps={showTimestamps}
              onUpdate={(patch) => updatePane(idx, patch)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
