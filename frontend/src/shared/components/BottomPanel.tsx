import { useRef, useState, useEffect, useCallback } from "react";
import { SystemTerminal } from "./SystemTerminal";
import { globalBus } from "../../core/global_bus";
import { wsUrl } from "../../core/ws_url";
import { SerialPlotter } from "../../plugins/monitorforge/SerialPlotter";
import type { SerialPlotterRef } from "../../plugins/monitorforge/SerialPlotter";
import { useSettingsStore } from "../../core/settings_store";
import { toast } from "../../shared/hooks/useToastStore";
import { saveToProject, exportTerminalText, exportPlotterCsv, dataUrlToBase64 } from "../../plugins/monitorforge/export";

type PanelTab = "shell" | "events" | "logs" | "serial";

interface BottomPanelProps {
  open: boolean;
  activeTab: PanelTab;
  onClose: () => void;
}

interface EventRow {
  id: number;
  ts: string;
  event: string;
  payload: string;
}

interface LogRow {
  level: string;
  msg: string;
}

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 220;
const LS_PANEL_H = "fob.panel.height";
const SNAP_SIZES = [
  { label: "S", h: 180 },
  { label: "M", h: 300 },
  { label: "L", h: 480 },
  { label: "↑", h: () => Math.floor(window.innerHeight * 0.85) },
] as const;

export function BottomPanel({ open, activeTab, onClose: _onClose }: BottomPanelProps) {
  const [height, setHeightRaw] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem(LS_PANEL_H) ?? "", 10);
    return isNaN(saved) ? DEFAULT_HEIGHT : Math.max(MIN_HEIGHT, saved);
  });
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const setHeight = useCallback((h: number) => {
    const maxH = Math.floor(window.innerHeight * 0.85);
    const next = Math.max(MIN_HEIGHT, Math.min(maxH, h));
    setHeightRaw(next);
    localStorage.setItem(LS_PANEL_H, String(next));
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    e.preventDefault();
  }, [height]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      const maxH = Math.floor(window.innerHeight * 0.85);
      setHeightRaw(Math.max(MIN_HEIGHT, Math.min(maxH, startH.current + delta)));
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        setHeightRaw((h) => { localStorage.setItem(LS_PANEL_H, String(h)); return h; });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!open) return null;

  return (
    <div
      style={{ height }}
      className="flex flex-col bg-fob-surface border-t-2 border-fob-border flex-shrink-0 relative"
    >
      {/* Resize handle + snap controls */}
      <div
        onMouseDown={onMouseDown}
        className="flex items-center justify-center gap-2 h-4 cursor-row-resize bg-fob-bg hover:bg-fob-border/30 transition-colors z-10 flex-shrink-0 select-none group"
        title="Drag to resize"
      >
        <span className="text-fob-border group-hover:text-fob-text-dim text-[10px] tracking-widest pointer-events-none">· · · · ·</span>
        <div className="flex gap-1 absolute right-2" onMouseDown={(e) => e.stopPropagation()}>
          {SNAP_SIZES.map((s) => (
            <button key={s.label}
              onClick={() => setHeight(typeof s.h === "function" ? s.h() : s.h)}
              className="px-1.5 py-0 rounded text-[9px] font-mono font-bold text-fob-text-dim hover:text-fob-orange hover:bg-fob-border/30 transition-colors leading-4"
            >{s.label}</button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden h-full">
        <div className={`h-full ${activeTab === "shell" ? "block" : "hidden"}`}>
          <SystemTerminal isOpen={open && activeTab === "shell"} />
        </div>
        {activeTab === "events" && <EventsLog />}
        {activeTab === "logs" && <LogsPanel />}
        {activeTab === "serial" && <SerialPane />}
      </div>
    </div>
  );
}

const KNOWN_BUS_EVENTS = [
  "workspace.project.changed",
  "noteforge.insert",
  "noteforge.refresh",
  "lensforge.camera.status",
  "footer.context",
  "app.navigate",
  "plugin.settings.load",
  "plugin.settings.loaded",
  "plugin.settings.save",
  "monitorforge.serial.status",
];

function EventsLog() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef(0);

  useEffect(() => {
    const addRow = (event: string) => (payload: unknown) => {
      const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
      const payloadStr = payload !== undefined ? JSON.stringify(payload).slice(0, 80) : "";
      setRows((prev) => {
        const next = [...prev, { id: ++counterRef.current, ts, event, payload: payloadStr }];
        return next.length > 200 ? next.slice(-200) : next;
      });
    };
    const unsubs = KNOWN_BUS_EVENTS.map((ev) => globalBus.on(ev, addRow(ev)));
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows]);

  const LEVEL_COLOR: Record<string, string> = {
    "workspace.project.changed": "text-fob-orange",
    "noteforge.insert": "text-fob-green",
    "noteforge.refresh": "text-teal-400",
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 border-b border-fob-border bg-fob-bg flex-shrink-0">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-fob-text-dim">Bus Events</span>
        <button onClick={() => setRows([])} className="text-[10px] font-mono text-fob-text-dim hover:text-fob-orange transition-colors">Clear</button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px]">
        {rows.length === 0 && (
          <div className="text-fob-text-dim py-4 text-center">No bus events yet — interact with plugins to see activity</div>
        )}
        {rows.map((r) => (
          <div key={r.id} className="flex gap-2 py-0.5 border-b border-fob-border/20">
            <span className="text-fob-text-dim flex-shrink-0 w-16">{r.ts}</span>
            <span className={`flex-shrink-0 w-52 truncate ${LEVEL_COLOR[r.event] ?? "text-fob-text"}`}>{r.event}</span>
            <span className="text-fob-text-dim truncate">{r.payload}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  info: "text-fob-text-dim",
  warn: "text-fob-yellow",
  error: "text-fob-red",
  debug: "text-fob-text-dim opacity-50",
};

const LOG_SOURCES = [
  { id: "backend", label: "Backend" },
  { id: "bridge", label: "Bridge" },
  { id: "frontend", label: "Frontend" },
  { id: "usb-bridge", label: "USB" },
] as const;

type LogSource = typeof LOG_SOURCES[number]["id"];

const LS_LOG_FONT = "fob.logs.fontSize";
const LOG_FONT_DEFAULT = 11;
const LOG_FONT_SIZES = [9, 10, 11, 12, 13, 14, 16, 18] as const;

function LogsPanel() {
  const [source, setSource] = useState<LogSource>("backend");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [loading, setLoading] = useState(true);
  const [autoFollow, setAutoFollow] = useState(true);
  const [fontSize, setFontSize] = useState<number>(() => {
    const s = parseInt(localStorage.getItem(LS_LOG_FONT) ?? "", 10);
    return isNaN(s) ? LOG_FONT_DEFAULT : (LOG_FONT_SIZES.includes(s as typeof LOG_FONT_SIZES[number]) ? s : LOG_FONT_DEFAULT);
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/logs/recent?n=300&source=${source}`);
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows as LogRow[]);
      }
    } catch { /* backend down */ }
    finally { setLoading(false); }
  }, [source]);

  useEffect(() => {
    setRows([]);
    setLoading(true);
    fetchLogs();
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [fetchLogs]);

  useEffect(() => {
    if (autoFollow && atBottomRef.current) bottomRef.current?.scrollIntoView();
  }, [rows, autoFollow]);

  const clearLog = useCallback(async () => {
    try {
      await fetch(`/api/v1/logs/${source}`, { method: "DELETE" });
      setRows([]);
    } catch { /* ignore */ }
  }, [source]);

  const changeFont = useCallback((next: number) => {
    localStorage.setItem(LS_LOG_FONT, String(next));
    setFontSize(next);
  }, []);

  const visible = filter === "all" ? rows : rows.filter((r) => r.level === filter);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Source sub-tabs */}
      <div className="flex items-stretch border-b border-fob-border bg-fob-bg flex-shrink-0">
        {LOG_SOURCES.map((s) => (
          <button key={s.id} onClick={() => setSource(s.id)}
            className={`px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-wide transition-colors border-b-2 ${
              source === s.id
                ? "border-fob-orange text-fob-orange bg-fob-surface"
                : "border-transparent text-fob-text-dim hover:text-fob-text"
            }`}>{s.label}</button>
        ))}
      </div>
      {/* Controls */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-fob-border bg-fob-bg flex-shrink-0">
        {(["all", "info", "warn", "error"] as const).map((lvl) => (
          <button key={lvl} onClick={() => setFilter(lvl)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase transition-colors ${
              filter === lvl ? "bg-fob-orange text-fob-accent-text" : "text-fob-text-dim hover:text-fob-text"
            }`}>{lvl}</button>
        ))}
        <div className="w-px bg-fob-border mx-1 self-stretch" />
        <button onClick={() => setAutoFollow((v) => !v)}
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase transition-colors ${
            autoFollow ? "bg-fob-orange text-fob-accent-text" : "text-fob-text-dim hover:text-fob-text border border-fob-border"
          }`}>⬇ Follow</button>
        <div className="flex-1" />
        <select
          value={fontSize}
          onChange={(e) => changeFont(Number(e.target.value))}
          className="bg-fob-bg border border-fob-border rounded text-[10px] font-mono text-fob-text-dim hover:border-fob-orange transition-colors px-1 py-0.5 cursor-pointer"
          title="Font size"
        >
          {LOG_FONT_SIZES.map((s) => (
            <option key={s} value={s}>{s}px</option>
          ))}
        </select>
        <div className="w-px bg-fob-border mx-1 self-stretch" />
        <button onClick={fetchLogs} className="text-[10px] font-mono text-fob-text-dim hover:text-fob-orange transition-colors">↻</button>
        <button onClick={clearLog} className="text-[10px] font-mono text-fob-text-dim hover:text-fob-red transition-colors ml-1">Clear</button>
      </div>
      {/* Log rows */}
      <div
        className="flex-1 overflow-y-auto px-2 py-1 font-mono"
        style={{ fontSize }}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {loading && <div className="text-fob-text-dim py-4 text-center">Loading…</div>}
        {!loading && visible.length === 0 && <div className="text-fob-text-dim py-4 text-center">No log entries</div>}
        {visible.map((r, i) => (
          <div key={i} className={`py-0.5 border-b border-fob-border/20 break-all ${LEVEL_STYLE[r.level] ?? "text-fob-text-dim"}`}>
            {r.msg}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const LS_SERIAL_BAUD = "fob.serial.baud";
const LS_SERIAL_HEX = "fob.serial.hex";

interface SerialLine {
  id: number;
  ts: string;
  text: string;
  dir: "rx" | "tx";
}

function SerialPane() {
  const [ports, setPorts] = useState<{ device: string; description: string }[]>([]);
  const [port, setPort] = useState("");
  const [baud, setBaud] = useState<number>(() => parseInt(localStorage.getItem(LS_SERIAL_BAUD) ?? "115200", 10));
  const [hexMode, setHexMode] = useState(() => localStorage.getItem(LS_SERIAL_HEX) === "1");
  const [view, setView] = useState<"terminal" | "plotter">("terminal");
  const [lines, setLines] = useState<SerialLine[]>([]);
  const [sendBuf, setSendBuf] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const serialBottomRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef(0);
  const rxBuf = useRef("");
  const hexModeRef = useRef(hexMode);
  hexModeRef.current = hexMode;
  const plotterRef = useRef<SerialPlotterRef>(null);

  useEffect(() => {
    fetch("/api/v1/serial/ports")
      .then((r) => r.ok ? r.json() : { ports: [] })
      .then((d) => {
        const p = (d.ports ?? []) as { device: string; description: string }[];
        setPorts(p);
        if (p.length > 0 && !port) setPort(p[0].device);
      })
      .catch(() => {});
  }, []);

  const addLine = useCallback((text: string, dir: "rx" | "tx") => {
    const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
    setLines((prev) => {
      const next = [...prev, { id: ++counterRef.current, ts, text, dir }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const connectSerial = useCallback(() => {
    if (!port) return;
    setConnecting(true);
    const ws = new WebSocket(wsUrl(`/api/v1/serial/stream?port=${encodeURIComponent(port)}&baud=${baud}`, 8000));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);
      addLine(`Connected to ${port} @ ${baud}`, "tx");
      globalBus.emit("monitorforge.serial.status", { connected: true, port, baud });
    };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        rxBuf.current += e.data;
        const parts = rxBuf.current.split("\n");
        rxBuf.current = parts.pop() ?? "";
        parts.forEach((line) => {
          const text = hexModeRef.current
            ? Array.from(line).map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ")
            : line;
          addLine(text, "rx");
        });
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
      addLine("Disconnected", "tx");
      globalBus.emit("monitorforge.serial.status", { connected: false, port, baud });
    };

    ws.onerror = () => {
      setConnected(false);
      setConnecting(false);
      addLine("Connection error", "tx");
    };
  }, [port, baud, addLine]);

  const disconnectSerial = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const send = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !sendBuf) return;
    wsRef.current.send(sendBuf + "\n");
    addLine(sendBuf, "tx");
    setSendBuf("");
  }, [sendBuf, addLine]);

  const projectName = useSettingsStore((s) => (s.config?.workspace as Record<string, string> | undefined)?.active_project ?? "");

  const handleExportTerminal = useCallback(async () => {
    const text = exportTerminalText(lines);
    if (!text) return;
    const filename = `serial_${Date.now()}.txt`;
    const result = await saveToProject(projectName, `captures/serial/${filename}`, text, filename);
    if (result.ok) toast.success(`Saved ${filename}`);
    else if (result.fallback) toast.info(`Downloaded ${filename}`);
    else toast.error(`Failed to save ${filename}`);
  }, [lines, projectName]);

  const handleExportPlotterCsv = useCallback(async () => {
    const csv = exportPlotterCsv(lines.filter((l) => l.dir === "rx").map((l) => l.text));
    if (!csv) return;
    const filename = `serial_plot_${Date.now()}.csv`;
    const result = await saveToProject(projectName, `captures/serial/${filename}`, csv, filename);
    if (result.ok) toast.success(`Saved ${filename}`);
    else if (result.fallback) toast.info(`Downloaded ${filename}`);
    else toast.error(`Failed to save ${filename}`);
  }, [lines, projectName]);

  const handleExportPlotterImage = useCallback(async () => {
    const dataUrl = plotterRef.current?.exportImage();
    if (!dataUrl) return;
    const parsed = dataUrlToBase64(dataUrl);
    if (!parsed) return;
    const filename = `serial_plot_${Date.now()}.png`;
    const result = await saveToProject(projectName, `captures/serial/${filename}`, parsed, filename);
    if (result.ok) toast.success(`Saved ${filename}`);
    else if (result.fallback) toast.info(`Downloaded ${filename}`);
    else toast.error(`Failed to save ${filename}`);
  }, [projectName]);

  useEffect(() => {
    serialBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  useEffect(() => { localStorage.setItem(LS_SERIAL_BAUD, String(baud)); }, [baud]);
  useEffect(() => { localStorage.setItem(LS_SERIAL_HEX, hexMode ? "1" : "0"); }, [hexMode]);
  useEffect(() => () => { wsRef.current?.close(); }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-fob-border bg-fob-bg flex-shrink-0 flex-wrap">
        <select
          value={port}
          onChange={(e) => setPort(e.target.value)}
          disabled={connected}
          className="rounded bg-fob-surface border border-fob-border text-[10px] font-mono text-fob-text px-1.5 py-0.5 disabled:opacity-50"
        >
          {ports.length === 0 && <option value="">No ports found</option>}
          {ports.map((p) => <option key={p.device} value={p.device}>{p.device}{p.description && p.description !== "n/a" ? ` — ${p.description}` : ""}</option>)}
        </select>
        <select
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={connected}
          className="rounded bg-fob-surface border border-fob-border text-[10px] font-mono text-fob-text px-1.5 py-0.5 disabled:opacity-50"
        >
          {BAUD_RATES.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <button
          onClick={connected ? disconnectSerial : connectSerial}
          disabled={connecting || !port}
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-colors disabled:opacity-50 border ${
            connected
              ? "bg-fob-red/20 text-fob-red hover:bg-fob-red/30 border-fob-red/40"
              : "bg-fob-orange/20 text-fob-orange hover:bg-fob-orange/30 border-fob-orange/40"
          }`}
        >
          {connecting ? "…" : connected ? "Disconnect" : "Connect"}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setView("terminal")}
          disabled={view === "terminal"}
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors disabled:opacity-40 ${
            view === "terminal"
              ? "bg-fob-orange text-fob-accent-text border-fob-orange"
              : "text-fob-text-dim border-fob-border hover:text-fob-text hover:bg-fob-bg"
          }`}
        >Terminal</button>
        <button
          onClick={() => setView("plotter")}
          disabled={view === "plotter"}
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors disabled:opacity-40 ${
            view === "plotter"
              ? "bg-fob-orange text-fob-accent-text border-fob-orange"
              : "text-fob-text-dim border-fob-border hover:text-fob-text hover:bg-fob-bg"
          }`}
        >Plotter</button>
        <button
          onClick={() => setHexMode((v) => !v)}
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors ${
            hexMode ? "bg-fob-orange text-fob-accent-text border-fob-orange" : "text-fob-text-dim border-fob-border hover:text-fob-text"
          }`}
        >HEX</button>
        <button onClick={() => setLines([])} className="text-[10px] font-mono text-fob-text-dim hover:text-fob-red transition-colors ml-1">Clear</button>
        {view === "terminal" ? (
          <button
            onClick={handleExportTerminal}
            disabled={lines.length === 0}
            className="px-2 py-0.5 rounded text-[10px] font-mono font-bold border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors disabled:opacity-40"
          >Export</button>
        ) : (
          <>
            <button
              onClick={handleExportPlotterCsv}
              disabled={lines.filter((l) => l.dir === "rx").length === 0}
              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors disabled:opacity-40"
            >CSV</button>
            <button
              onClick={handleExportPlotterImage}
              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold border border-fob-border text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors"
            >PNG</button>
          </>
        )}
      </div>

      {/* Content: terminal or plotter */}
      {view === "plotter" ? (
        <div className="flex-1 overflow-hidden bg-fob-bg p-1">
          <SerialPlotter ref={plotterRef} lines={lines.filter((l) => l.dir === "rx").map((l) => l.text)} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px]">
          {lines.length === 0 && (
            <div className="text-fob-text-dim py-4 text-center">No data — select a port and connect</div>
          )}
          {lines.map((l) => (
            <div key={l.id} className={`flex gap-2 py-0.5 border-b border-fob-border/20 ${l.dir === "tx" ? "opacity-60" : ""}`}>
              <span className="flex-shrink-0 w-16 text-fob-text-dim">{l.ts}</span>
              <span className={`flex-shrink-0 w-4 font-bold ${l.dir === "rx" ? "text-fob-green" : "text-fob-orange"}`}>{l.dir === "rx" ? "←" : "→"}</span>
              <span className="break-all text-fob-text">{l.text}</span>
            </div>
          ))}
          <div ref={serialBottomRef} />
        </div>
      )}

      {/* Send bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-t border-fob-border bg-fob-bg flex-shrink-0">
        <input
          value={sendBuf}
          onChange={(e) => setSendBuf(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder={connected ? "Type and press Enter to send…" : "Not connected"}
          disabled={!connected}
          className="flex-1 rounded bg-fob-surface border border-fob-border text-[11px] font-mono text-fob-text px-2 py-0.5 placeholder:text-fob-text-dim disabled:opacity-40 outline-none focus:border-fob-orange transition-colors"
        />
        <button
          onClick={send}
          disabled={!connected || !sendBuf}
          className="px-3 py-0.5 rounded text-[10px] font-mono font-bold bg-fob-orange/20 text-fob-orange border border-fob-orange/40 hover:bg-fob-orange/30 transition-colors disabled:opacity-40"
        >Send</button>
      </div>
    </div>
  );
}
