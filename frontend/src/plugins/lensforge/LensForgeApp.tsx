import { useState, useCallback, useEffect, useRef } from "react";
import { LayoutDashboard } from "lucide-react";
import { LensPane } from "./LensPane";
import type { PaneConfig, LensSnapshot, LayoutCount, PaneStatus, PaneStatusState, StreamSource } from "./types";
import { defaultPane } from "./types";
import type { PluginBus } from "../types";
import { globalBus } from "../../core/global_bus";
import { useSettingsStore } from "../../core/settings_store";

const SETTINGS_KEY = "lensforge";
const PANE_IDS = ["pane-0", "pane-1", "pane-2"] as const;
const EMPTY_CFG: Record<string, unknown> = {};

const LAYOUTS: LayoutCount[] = [1, 2, 3];

interface LensForgeAppProps {
  bus: PluginBus;
}

function buildDefaultPanes(defaultDeviceId = ""): PaneConfig[] {
  return PANE_IDS.map((id) => defaultPane(id, defaultDeviceId));
}

export function LensForgeApp({ bus }: LensForgeAppProps) {
  const [layout, setLayout] = useState<LayoutCount>(1);
  const cfg = useSettingsStore((s) => (s.config?.lensforge as Record<string, unknown> | undefined) ?? EMPTY_CFG);
  const defaultCamera = (cfg.defaultCamera as string | undefined) ?? "";
  const [panes, setPanes] = useState<PaneConfig[]>(() => buildDefaultPanes(defaultCamera));
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [saveFolder, setSaveFolder] = useState<string>("");
  const [paneStatuses, setPaneStatuses] = useState<PaneStatus[]>([]);
  const [sharedStreams, setSharedStreams] = useState<Record<string, MediaStream | null>>({});

  const handleStreamReady = useCallback((paneId: string, stream: MediaStream | null) => {
    setSharedStreams((prev) => {
      if (prev[paneId] === stream) return prev;
      return { ...prev, [paneId]: stream };
    });
  }, []);

  const handleStatusChange = useCallback((s: PaneStatus) => {
    setPaneStatuses((prev) => [
      ...prev.filter((p) => p.paneId !== s.paneId),
      s,
    ]);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    fetch("/api/v1/notes/folders")
      .then((r) => r.ok ? r.json() : { folders: [] })
      .then((d) => setFolders(d.folders as string[]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bus.emit("plugin.settings.load", { key: SETTINGS_KEY });
    const unsub = bus.on("plugin.settings.loaded", (payload: unknown) => {
      const { key, settings } = payload as { key: string; settings: Record<string, unknown> | null };
      if (key !== SETTINGS_KEY || !settings) return;
      if (typeof settings.layout === "number") setLayout(settings.layout as LayoutCount);
      if (Array.isArray(settings.panes)) setPanes((settings.panes as PaneConfig[]).map((p) => ({ ...defaultPane(p.id), ...p })));
    });
    return unsub;
  }, [bus]);

  const saveSettings = useCallback(
    (nextLayout: LayoutCount, nextPanes: PaneConfig[]) => {
      bus.emit("plugin.settings.save", {
        key: SETTINGS_KEY,
        settings: { layout: nextLayout, panes: nextPanes },
      });
    },
    [bus]
  );

  const updatePane = useCallback(
    (idx: number, patch: Partial<PaneConfig>) => {
      setPanes((prev) => {
        const next = prev.map((p, i) => (i === idx ? { ...p, ...patch } : p));
        saveSettings(layout, next);
        return next;
      });
    },
    [layout, saveSettings]
  );

  const handleSnapshot = useCallback(
    async (snap: LensSnapshot) => {
      const ts = new Date(snap.timestamp).toLocaleString();
      const totalItems = snap.layers.reduce((s, l) => s + l.items.length, 0);
      const annBlock =
        totalItems > 0
          ? `\n\n<details><summary>Annotations (${totalItems} items, ${snap.layers.length} layers)</summary>\n\n\`\`\`json\n${JSON.stringify(snap.layers, null, 2)}\n\`\`\`\n\n</details>`
          : "";

      const content =
        `# Lens Capture — ${ts}\n\n` +
        `**Pane:** ${snap.paneId}  \n` +
        `**Label:** ${snap.label || "—"}  \n` +
        `**Filter:** ${snap.filter}  \n\n` +
        `![lens-capture](${snap.imageDataUrl})` +
        `${annBlock}\n`;

      const noteName = `lens-${snap.timestamp}`;
      try {
        const res = await fetch(`/api/v1/notes/${encodeURIComponent(noteName)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, folder: saveFolder || undefined }),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        globalBus.emit("noteforge.refresh");
        globalBus.emit("noteforge.open", { name: noteName });
        globalBus.emit("workspace.counts.refresh");
        showToast(`Saved to Notes ✓`);
      } catch {
        const key = `fob_note_${noteName}`;
        localStorage.setItem(key, JSON.stringify({ name: noteName, content, updated_at: Date.now() / 1000 }));
        showToast("Saved locally (server offline)");
      }
    },
    [showToast, saveFolder]
  );

  const handleLayoutChange = useCallback(
    (l: LayoutCount) => {
      setLayout(l);
      saveSettings(l, panes);
    },
    [panes, saveSettings]
  );

  useEffect(() => {
    const streaming = paneStatuses.filter((s) => s.state === "streaming");
    globalBus.emit("lensforge.camera.status", {
      connected: streaming.length > 0,
      count: streaming.length,
      detail: streaming.length > 0
        ? streaming.map((s) => `${s.width}\u00d7${s.height}`).join(", ")
        : "No cameras active",
    });
  }, [paneStatuses]);

  const activePanes = panes.slice(0, layout);

  return (
    <div className="flex h-full flex-col bg-fob-surface text-fob-text">
      {/* Toolbar */}
      <div 
        className="flex items-center gap-2 border-b border-fob-border bg-fob-surface px-3"
        style={{
          height: '53px',
        }}
      >
        <LayoutDashboard size={14} className="text-fob-orange" />
        <span className="text-xs font-bold uppercase tracking-wider text-fob-orange">LensForge</span>

        <div className="ml-2 flex gap-1 items-center">
          {LAYOUTS.map((l) => (
            <button
              key={l}
              onClick={() => handleLayoutChange(l)}
              className={`min-w-[28px] rounded px-2 py-1 text-[10px] font-bold transition-colors flex items-center justify-center ${
                layout === l
                  ? "bg-fob-orange text-fob-accent-text"
                  : "bg-fob-border text-fob-text-dim hover:text-fob-text"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Per-pane status dots */}
        <div className="flex items-center gap-2 mx-2">
          {activePanes.map((pane) => {
            const s = paneStatuses.find((p) => p.paneId === pane.id);
            const state: PaneStatusState = s?.state ?? "off";
            const dotColor = state === "streaming" ? "bg-fob-green"
              : state === "paused" ? "bg-fob-orange"
              : state === "error" ? "bg-fob-red"
              : "bg-fob-border";
            return (
              <div key={pane.id} className="flex items-center gap-1">
                <span className={`h-2 w-2 rounded-full flex-shrink-0 ${dotColor}`} />
                <span className="text-[9px] font-mono text-fob-text-dim">
                  {state === "streaming" && s && s.width > 0
                    ? `${s.width}×${s.height}`
                    : state}
                </span>
              </div>
            );
          })}
        </div>
        {/* Save-to folder picker - moved to left */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-fob-text-dim">Save to:</span>
          <select
            value={saveFolder}
            onChange={(e) => setSaveFolder(e.target.value)}
            className="rounded bg-fob-bg px-1 py-0.5 text-[9px] text-fob-text-dim outline-none"
          >
            <option value="">/ Notes root</option>
            {folders.map((f) => (
              <option key={f} value={f}>/{f}</option>
            ))}
          </select>
        </div>
        {/* Original selector - moved after save widget */}
        <div className="flex items-center gap-1">
          <select
            value={layout}
            onChange={(e) => setLayout(parseInt(e.target.value) as LayoutCount)}
            className="rounded bg-fob-bg px-1 py-0.5 text-[9px] text-fob-text-dim outline-none"
          >
            <option value="1">1 pane</option>
            <option value="2">2 panes</option>
            <option value="3">3 panes</option>
          </select>
        </div>
      </div>

      {/* Pane area */}
      <div
        className="flex flex-1 gap-1 overflow-hidden p-1"
        style={{ display: "flex", flexDirection: "row" }}
      >
        {activePanes.map((pane, idx) => (
          <div key={pane.id} className="min-w-0 flex-1">
            <LensPane
              config={pane}
              onChange={(patch) => updatePane(idx, patch)}
              onSnapshot={handleSnapshot}
              onStatusChange={handleStatusChange}
              onStreamReady={(s) => handleStreamReady(pane.id, s)}
              sharedStream={
                pane.streamSource !== "own"
                  ? (sharedStreams[pane.streamSource] ?? null)
                  : null
              }
              availableSources={[
                "own",
                ...activePanes
                  .filter((p) => p.id !== pane.id && p.streamSource === "own")
                  .map((p) => p.id as StreamSource),
              ]}
            />
          </div>
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-fob-surface px-4 py-2 text-xs font-bold text-fob-green shadow-lg ring-1 ring-fob-border">
          {toast}
        </div>
      )}
    </div>
  );
}
