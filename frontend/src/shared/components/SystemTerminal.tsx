import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "../../core/ws_url";

const LS_FONT = "fob.terminal.fontSize";
const DEFAULT_FONT = 13;
const MIN_FONT = 9;
const MAX_FONT = 22;

interface SystemTerminalProps {
  isOpen: boolean;
}

export function SystemTerminal({ isOpen }: SystemTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem(LS_FONT) ?? "", 10);
    return isNaN(saved) ? DEFAULT_FONT : Math.max(MIN_FONT, Math.min(MAX_FONT, saved));
  });
  const [autoFollow, setAutoFollow] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);

  const changeFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(MIN_FONT, Math.min(MAX_FONT, prev + delta));
      localStorage.setItem(LS_FONT, String(next));
      if (xtermRef.current) {
        xtermRef.current.options.fontSize = next;
        fitAddonRef.current?.fit();
      }
      return next;
    });
  }, []);

  const clearScreen = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send("clear\n");
    } else {
      xtermRef.current?.clear();
    }
  }, []);

  const newSession = useCallback(() => {
    setSessionKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!terminalRef.current || !isOpen) return;

    let cancelled = false;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize,
      fontFamily: '"JetBrains Mono", "FiraCode Nerd Font", "Fira Code", "Noto Mono", "DejaVu Sans Mono", monospace',
      theme: {
        background: "#000000",
        foreground: "#33FF33",
        cursor: "#FF9900",
        selectionBackground: "rgba(255, 153, 0, 0.3)",
        black: "#1A1A24",
        red: "#FF3333",
        green: "#33FF33",
        yellow: "#FF9900",
        blue: "#5B92E5",
        magenta: "#B57EDC",
        cyan: "#2EA5EB",
        white: "#EAEAEA",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    if (autoFollow) {
      term.onScroll(() => {
        if (autoFollow) term.scrollToBottom();
      });
    }

    const termWsUrl = wsUrl("/api/v1/system/terminal", window.location.port === "5173" ? 8000 : undefined);
    const ws = new WebSocket(termWsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) { ws.close(); return; }
      term.write("\r\n\x1b[1;33m[FOB] Terminal connected\x1b[0m\r\n");
      const dims = { cols: term.cols, rows: term.rows };
      ws.send(`__RESIZE__:${dims.cols},${dims.rows}`);
    };

    ws.onmessage = (event) => {
      if (!cancelled) term.write(event.data);
    };

    ws.onclose = () => {
      if (!cancelled) term.write("\r\n\x1b[1;31m[FOB] Terminal disconnected\x1b[0m\r\n");
    };

    const dataDisposer = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
          const cols = xtermRef.current.cols;
          const rows = xtermRef.current.rows;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(`__RESIZE__:${cols},${rows}`);
          }
        } catch {
          // Ignore resize errors during hidden transitions
        }
      }
    });

    resizeObserver.observe(terminalRef.current);

    return () => {
      cancelled = true;
      dataDisposer.dispose();
      resizeObserver.disconnect();
      term.dispose();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [isOpen, fontSize, autoFollow, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-black border-b border-fob-border flex-shrink-0">
        <button
          onClick={() => setAutoFollow((v) => !v)}
          title="Auto-follow (scroll to bottom on new output)"
          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase transition-colors ${
            autoFollow ? "bg-fob-orange text-fob-accent-text" : "text-fob-text-dim hover:text-fob-text border border-fob-border"
          }`}
        >⬇ Follow</button>
        <button onClick={clearScreen} title="Clear screen"
          className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase text-fob-text-dim hover:text-fob-orange border border-fob-border transition-colors"
        >⌫ Clear</button>
        <button onClick={newSession} title="Kill and start new session"
          className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase text-fob-text-dim hover:text-fob-red border border-fob-border transition-colors"
        >↺ New</button>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-fob-text-dim mr-1">{fontSize}px</span>
        <button onClick={() => changeFontSize(-1)} disabled={fontSize <= MIN_FONT}
          className="w-6 h-6 rounded text-sm font-bold text-fob-text-dim hover:text-fob-orange border border-fob-border disabled:opacity-30 transition-colors leading-none"
        >−</button>
        <button onClick={() => changeFontSize(1)} disabled={fontSize >= MAX_FONT}
          className="w-6 h-6 rounded text-sm font-bold text-fob-text-dim hover:text-fob-orange border border-fob-border disabled:opacity-30 transition-colors leading-none"
        >+</button>
      </div>
      <div
        ref={terminalRef}
        className="flex-1 bg-black min-h-0"
        style={{ display: isOpen ? "block" : "none" }}
      />
    </div>
  );
}
