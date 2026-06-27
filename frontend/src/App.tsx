import { useEffect, useRef, useState } from "react";
import { eventBus } from "./core/event_bus";
import { useSettingsStore } from "./core/settings_store";
import { ExpandingHeader } from "./shared/components/ExpandingHeader";
import { BottomPanel } from "./shared/components/BottomPanel";
import { AppFooter } from "./shared/components/AppFooter";
import type { FooterItem } from "./shared/components/AppFooter";
import { ToastContainer } from "./shared/components/ToastContainer";
import { globalBus } from "./core/global_bus";
import { FileTreePanel } from "./shared/components/FileTreePanel";
import { PLUGINS, SETTINGS_PLUGIN, SimpleBus } from "./plugins/registry";
import type { PluginLifecycle } from "./plugins/types";

interface PluginEntry {
  instance: PluginLifecycle;
  container: HTMLDivElement;
  bus: SimpleBus;
  mounted: boolean;
}

// Hook to detect vertical vs horizontal layout
function useLayoutDetection() {
  const [isVertical, setIsVertical] = useState(false);

  useEffect(() => {
    const checkOrientation = () => {
      const height = window.innerHeight;
      const width = window.innerWidth;
      setIsVertical(height > width * 1.2); // Consider vertical if height is 20%+ greater than width
    };

    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    return () => window.removeEventListener('resize', checkOrientation);
  }, []);

  return isVertical;
}

// Probe bridge server via HTTP health endpoint to avoid WS noise
function useBridgeOnline() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const probe = async () => {
      if (controller.signal.aborted) return;
      try {
        const res = await fetch(`http://${window.location.hostname}:8765/health`, {
          method: "GET",
          signal: controller.signal,
        });
        setOnline(res.ok);
      } catch {
        setOnline(false);
      }
      timer = setTimeout(probe, 10000);
    };

    probe();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return online;
}

const PLUGIN_KEY = "forge:lastPlugin";

function App() {
  const connected = useSettingsStore((s) => s.connected);
  const config = useSettingsStore((s) => s.config);
  const savedPlugin = (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(PLUGIN_KEY) : null) ?? "dashboard";
  const [activePlugin, setActivePlugin] = useState(savedPlugin);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [bottomPanelTab, setBottomPanelTab] = useState<"shell" | "events" | "logs" | "serial">("shell");
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [usbDevice, setUsbDevice] = useState<{ connected: boolean; name: string } | null>(null);
  const [camStatus, setCamStatus] = useState<{ connected: boolean; count: number; detail: string } | null>(null);
  const pokitConnected = useSettingsStore((s) => s.pluginConnected["pocketforge"] ?? false);
  const bridgeOnline = useBridgeOnline();
  const pokitTransport = useSettingsStore((s) => s.pluginTransport["pocketforge"] ?? "web");
  const pluginsRef = useRef<Map<string, PluginEntry>>(new Map());
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hasSetDefault = useRef(false);
  const activePluginRef = useRef(activePlugin);
  const isVertical = useLayoutDetection();
  useEffect(() => { activePluginRef.current = activePlugin; }, [activePlugin]);

  // Persist active plugin so F5 returns to the same view
  useEffect(() => {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(PLUGIN_KEY, activePlugin);
  }, [activePlugin]);

  // Keyboard shortcuts: Ctrl+1-6 plugins, Ctrl+' panel, F11, ?, Ctrl+,
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = (e.target instanceof HTMLElement) &&
        (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);

      // Non-modified shortcuts (guard against input fields)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "F11") { e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); return; }
        if (e.key === "?" && !inInput) { e.preventDefault(); setShortcutsOpen((v) => !v); return; }
        if (e.key === "Escape" && shortcutsOpen) { setShortcutsOpen(false); return; }
      }

          if (!e.ctrlKey) return;
      if (e.key === "'") { e.preventDefault(); setBottomPanelOpen((v) => !v); return; }
      if (e.key === ",") { e.preventDefault(); setActivePlugin("settings"); return; }
      if (e.shiftKey && e.key === "E") { e.preventDefault(); setFileTreeOpen((v) => !v); return; }
      if (inInput) return;
      const idx = parseInt(e.key) - 1;
      if (idx >= 0 && idx < PLUGINS.length) {
        e.preventDefault();
        setActivePlugin(PLUGINS[idx].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcutsOpen]);

  useEffect(() => {
    eventBus.connect();
    return () => eventBus.disconnect();
  }, []);

  useEffect(() => {
    return globalBus.on("waveforge.usb.status", (payload) => {
      const { connected, name } = payload as { connected: boolean; name: string };
      setUsbDevice(connected ? { connected, name } : null);
    });
  }, []);

  useEffect(() => {
    return globalBus.on("lensforge.camera.status", (payload) => {
      const p = payload as { connected: boolean; count: number; detail: string };
      setCamStatus(p.connected ? p : null);
    });
  }, []);

  useEffect(() => {
    return globalBus.on("pocketforge.transport.set", (payload) => {
      const { transport } = payload as { transport: "web" | "bridge" };
      useSettingsStore.getState().setPluginTransport("pocketforge", transport);
    });
  }, []);

  useEffect(() => {
    const ui = config?.ui as Record<string, unknown> | undefined;
    if (!hasSetDefault.current && ui?.defaultPlugin) {
      hasSetDefault.current = true;
      // Only apply config default on fresh sessions, not on F5 restores
      const restored = typeof sessionStorage !== "undefined" && sessionStorage.getItem(PLUGIN_KEY);
      if (!restored) setActivePlugin(String(ui.defaultPlugin));
    }
  }, [config]);

  // Mount the active plugin once; only the active plugin's container is in the DOM
  useEffect(() => {
    const mountOrShow = async () => {
      // Atomically replace wrapper contents with ONLY the active plugin container.
      // React roots survive DOM detachment — state and subscriptions stay alive.
      let entry = pluginsRef.current.get(activePlugin);

      if (!entry) {
        const descriptor = activePlugin === "settings"
          ? SETTINGS_PLUGIN
          : PLUGINS.find((p) => p.id === activePlugin);
        if (!descriptor || !wrapperRef.current) return;

        const container = document.createElement("div");
        container.className = "absolute inset-0 w-full h-full";
        container.dataset.pluginId = activePlugin;

        const bus = new SimpleBus();
        const unsubLoad = bus.on("plugin.settings.load", (payload: unknown) => {
          const { key } = payload as { key: string };
          const cfg = useSettingsStore.getState().config;
          const settings = (cfg?.[key] as Record<string, unknown> | undefined) ?? null;
          bus.emit("plugin.settings.loaded", { key, settings });
        });
        const unsubSave = bus.on("plugin.settings.save", (payload: unknown) => {
          const { key, settings } = payload as { key: string; settings: Record<string, unknown> };
          useSettingsStore.getState().updateBlock(key, settings);
        });
        const unsubNav = bus.on("app.navigate", (payload: unknown) => {
          const { plugin } = payload as { plugin: string };
          if (plugin) setActivePlugin(plugin);
        });
        (bus as unknown as Record<string, unknown>).__unsubs = [unsubLoad, unsubSave, unsubNav];

        const mod = await descriptor.load();
        const instance = mod.default;
        instance.mount(container, bus);

        entry = { instance, container, bus, mounted: true };
        pluginsRef.current.set(activePlugin, entry);
      }

      // Replace all wrapper children with ONLY the active container
      if (entry && wrapperRef.current) {
        wrapperRef.current.replaceChildren(entry.container);
      }
    };

    mountOrShow();
  }, [activePlugin]);

  // Unmount all plugins only when App itself unmounts
  useEffect(() => {
    return () => {
      pluginsRef.current.forEach((e) => { e.instance.unmount(); });
    };
  }, []);

  const pybtLabel = pokitTransport === "bridge" ? "PyBT" : "WebBT";

  const footerItems: FooterItem[] = [
    {
      id: "core", label: "CORE",
      color: connected ? "bg-fob-green" : "bg-fob-text-dim",
      active: connected,
      detail: connected ? "Backend WS connected" : "Backend offline",
      pluginId: "dashboard",
      actions: connected ? [
        { label: "Reconnect", variant: "primary", onClick: () => { eventBus.disconnect(); setTimeout(() => eventBus.connect(), 300); } },
      ] : [
        { label: "Reconnect", variant: "primary", onClick: () => { eventBus.disconnect(); setTimeout(() => eventBus.connect(), 300); } },
      ],
    },
    {
      id: "bt", label: pokitConnected ? "BT: Pokit Pro" : "BT",
      color: pokitConnected ? (pokitTransport === "bridge" ? "bg-fob-orange" : "bg-teal-400") : "bg-fob-text-dim",
      active: pokitConnected,
      detail: pokitConnected
        ? `Pokit Pro — via ${pokitTransport === "bridge" ? "Python Bridge" : "Web Bluetooth"}`
        : "No BLE device paired",
      pluginId: "pocketforge",
      actions: pokitConnected ? [
        { label: "Disconnect", variant: "danger", onClick: () => { import("./plugins/pocketforge/sharedTransport").then(m => { const t = m.getSharedTransport(); if (t) t.disconnect?.(); }); } },
      ] : [],
    },
    {
      id: "pybt", label: pybtLabel,
      color: pokitConnected ? "bg-fob-green" : (bridgeOnline ? "bg-fob-orange" : "bg-fob-text-dim"),
      active: pokitConnected || bridgeOnline,
      detail: bridgeOnline
        ? `Active transport: ${pokitTransport === "bridge" ? "Python Bridge" : "Web Bluetooth"}`
        : "Bridge server offline (port 8765)",
      pluginId: "pocketforge",
      actions: bridgeOnline ? [
        pokitTransport !== "bridge"
          ? { label: "Switch to Bridge", variant: "primary" as const, onClick: () => globalBus.emit("pocketforge.transport.set", { transport: "bridge" }) }
          : { label: "Switch to Web BT", variant: "default" as const, onClick: () => globalBus.emit("pocketforge.transport.set", { transport: "web" }) },
      ] : [],
    },
    {
      id: "usb", label: usbDevice ? `USB: ${usbDevice.name}` : "USB",
      color: usbDevice ? "bg-fob-green" : "bg-fob-text-dim",
      active: !!usbDevice,
      detail: usbDevice ? `${usbDevice.name} connected via USB bridge` : "No USB device connected",
      pluginId: "waveforge",
      actions: [],
    },
    {
      id: "cam", label: camStatus ? `CAM: ${camStatus.count}` : "CAM",
      color: camStatus ? "bg-purple-400" : "bg-fob-text-dim",
      active: !!camStatus,
      detail: camStatus ? camStatus.detail : "No cameras streaming",
      pluginId: "lensforge",
      actions: [],
    },
    {
      id: "psu", label: "PSU",
      color: "bg-fob-green",
      active: true,
      detail: "Power nominal",
      actions: [],
    },
  ];

  return (
    <div className="flex flex-col h-screen w-screen bg-fob-bg text-fob-text font-sans overflow-hidden select-none">
      {/* Expanding Header (always floats outside work area) */}
      <ExpandingHeader
        activePlugin={activePlugin}
        onSelect={setActivePlugin}
        config={config}
        updateBlock={useSettingsStore.getState().updateBlock}
        onOpenSettings={() => setActivePlugin("settings")}
        onOpenDashboard={() => setActivePlugin("dashboard")}
      />

      {/* Main Content Area */}
      <div 
        className="flex flex-1 overflow-hidden relative min-h-0"
        style={{ 
          marginTop: isVertical ? 'calc(var(--fob-plugin-bar-height, 48px) + 8px)' : '0px',
          transition: 'margin-top 0.3s ease-in-out'
        }}
      >
        {/* FileTree Panel */}
        <FileTreePanel
          projectName={(config?.workspace as Record<string, string> | undefined)?.active_project ?? null}
          open={fileTreeOpen}
          onOpenFile={(_path, ext) => {
            if (ext === ".md") setActivePlugin("noteforge");
            else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") setActivePlugin("lensforge");
          }}
        />

        <div className="flex flex-col flex-1 overflow-hidden">
          <main className="flex-1 p-3 overflow-hidden relative">
            <div ref={wrapperRef} className="w-full h-full border-2 border-fob-border rounded-lg overflow-hidden relative min-h-0" />
          </main>

          <BottomPanel
            open={bottomPanelOpen}
            activeTab={bottomPanelTab}
            onClose={() => setBottomPanelOpen(false)}
          />
        </div>
      </div>

      <AppFooter
        items={footerItems}
        bottomPanelOpen={bottomPanelOpen}
        activeTab={bottomPanelTab}
        onToggleBottomPanel={() => setBottomPanelOpen((v) => !v)}
        onSelectTab={setBottomPanelTab}
        onNavigate={setActivePlugin}
      />

      <ToastContainer />

      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="bg-fob-surface border border-fob-border rounded-xl shadow-2xl p-6 w-[480px] max-w-[95vw] max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="font-mono text-sm font-bold text-fob-orange tracking-wider">KEYBOARD SHORTCUTS</span>
              <button onClick={() => setShortcutsOpen(false)} className="text-fob-text-dim hover:text-fob-text font-mono text-xs px-2 py-1">[x]</button>
            </div>
            {([
              { scope: "Global", rows: [
                ["Ctrl+1–6", "Switch plugin (Dashboard, Pocket, Wave, Lens, Notes, Monitor)"],
                ["Ctrl+'", "Toggle bottom panel (Shell / Events / Logs / Serial)"],
                ["Ctrl+Shift+E", "Toggle file tree"],
                ["Ctrl+,", "Open Settings"],
                ["F11", "Toggle fullscreen"],
                ["?", "Show/hide this overlay"],
              ]},
              { scope: "PocketForge (Meter tab)", rows: [
                ["H", "Toggle Hold"],
                ["R", "Toggle REL"],
              ]},
            ] as { scope: string; rows: [string, string][] }[]).map(({ scope, rows }) => (
              <div key={scope} className="mb-4">
                <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-fob-text-dim mb-2">{scope}</div>
                <table className="w-full">
                  <tbody className="divide-y divide-fob-border/20">
                    {rows.map(([key, desc]) => (
                      <tr key={key}>
                        <td className="py-1.5 pr-4 font-mono text-xs text-fob-orange w-40">{key}</td>
                        <td className="py-1.5 font-mono text-xs text-fob-text-dim">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="text-[10px] font-mono text-fob-text-dim mt-2">Press <span className="text-fob-orange">?</span> or <span className="text-fob-orange">Esc</span> to close</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
