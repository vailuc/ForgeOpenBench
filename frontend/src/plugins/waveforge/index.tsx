import { PluginErrorBoundary } from "../../shared/components/PluginErrorBoundary";
import { globalBus } from "../../core/global_bus";
import { createRoot, type Root } from "react-dom/client";
import { useState, useEffect, useRef, useCallback } from "react";
import type { PluginLifecycle, PluginBus } from "../types";
import { getSharedUsbTransport, resetSharedUsbTransport } from "./sharedUsbTransport";
import { WaveformLaView } from "./WaveformLaView";
import { WaveformDsoView } from "./WaveformDsoView";
import type { UsbDeviceInfo } from "./usbTypes";
import { useSettingsStore } from "../../core/settings_store";

type Tab = "la" | "dso";
type ConnectionState = "disconnected" | "connecting" | "connected";
const EMPTY_CFG: Record<string, unknown> = {};
const TAB_KEY = "waveforge:lastTab";
const SESSION_KEY = "waveforge:sessionActive";

function WaveForgeApp({ bus: _bus }: { bus: PluginBus }) {
  const savedTab = (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(TAB_KEY) : null) as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(savedTab ?? "la");
  // Track whether this session was restored (F5) vs fresh (new tab / hard refresh)
  const wasPreviouslyActive = typeof sessionStorage !== "undefined" && sessionStorage.getItem(SESSION_KEY) === "1";
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(SESSION_KEY, "1");
  const scopeNeedsResetRef = useRef(wasPreviouslyActive);
  const [connState, setConnState] = useState<ConnectionState>("disconnected");
  const [serverOnline, setServerOnline] = useState(false);
  const [devices, setDevices] = useState<UsbDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<UsbDeviceInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const cfg = useSettingsStore((s) => (s.config?.waveforge as Record<string, unknown> | undefined) ?? EMPTY_CFG);
  const defaultDevicePattern = (cfg.defaultDevice as string | undefined) ?? "";
  const transportRef = useRef(getSharedUsbTransport());
  const selectedDeviceRef = useRef<UsbDeviceInfo | null>(null);
  useEffect(() => { selectedDeviceRef.current = selectedDevice; }, [selectedDevice]);

  const pickDevice = useCallback((found: UsbDeviceInfo[]) => {
    if (!found.length) return null;
    if (!defaultDevicePattern) return found[0];
    const pat = defaultDevicePattern.toLowerCase();
    return found.find((d) => d.name.toLowerCase().includes(pat)) ?? found[0];
  }, [defaultDevicePattern]);

  useEffect(() => {
    const t = transportRef.current;
    const tryAutoConnect = (found: UsbDeviceInfo[]) => {
      setDevices(found);
      // Only auto-pick a device if the user hasn't manually selected one
      if (found.length > 0 && !selectedDeviceRef.current) {
        const device = pickDevice(found);
        if (!device) return;
        setSelectedDevice(device);
        selectedDeviceRef.current = device;
        // Auto-connect and switch to the tab matching the detected mode
        setTimeout(() => connectRef.current(), 100); // Small delay to ensure state is set
      }
    };
    const off = t.onConnectionChange((online) => {
      setServerOnline(online);
      if (!online) {
        setConnState("disconnected");
        setDevices([]);
        setSelectedDevice(null);
        selectedDeviceRef.current = null;
      } else {
        // Auto-scan when bridge comes online — preserve user selection if already set
        void t.scan().then(tryAutoConnect).catch(() => {});
      }
    });
    // If already connected on mount, sync state + scan
    if (t.isConnected) {
      setServerOnline(true);
      void t.scan().then(tryAutoConnect).catch(() => {});
    }
    return off;
  }, []);

  const scan = useCallback(async () => {
    const t = transportRef.current;
    if (!t.isConnected) return;
    setScanning(true);
    try {
      const found = await t.scan();
      setDevices(found);
      if (found.length > 0 && !selectedDeviceRef.current) setSelectedDevice(pickDevice(found));
    } catch (e) {
      console.warn("[WaveForge] scan error", e);
    } finally {
      setScanning(false);
    }
  }, [pickDevice]);

  const connectingRef = useRef(false);
  const connect = useCallback(async () => {
    const device = selectedDeviceRef.current;
    if (!device || connectingRef.current) return;
    connectingRef.current = true;
    setConnState("connecting");
    try {
      await transportRef.current.connectDevice(device);
      globalBus.emit("waveforge.usb.status", { connected: true, name: device.name });
      setConnState("connected");
      // Auto-switch to the tab matching the device mode
      setActiveTab(device.mode === "dso" ? "dso" : "la");
    } catch (e) {
      console.warn("[WaveForge] connect error", e);
      setConnState("disconnected");
    } finally {
      connectingRef.current = false;
    }
  }, []);
  const connectRef = useRef(connect);
  useEffect(() => { connectRef.current = connect; }, [connect]);

  const disconnect = useCallback(async () => {
    try {
      await transportRef.current.disconnectDevice();
    } catch { }
    setConnState("disconnected");
    globalBus.emit("waveforge.usb.status", { connected: false, name: "" });
  }, []);

  const connected = connState === "connected";

  // Force disconnect on first scope visit after a refresh if still connected.
  // The USB stream state from before the refresh is stale; a reconnect gives a clean start.
  const resettingRef = useRef(false);
  useEffect(() => {
    if (activeTab === "dso" && connected && scopeNeedsResetRef.current && !resettingRef.current) {
      resettingRef.current = true;
      setIsResetting(true);
      scopeNeedsResetRef.current = false;
      (async () => {
        try {
          await disconnect();
          if (selectedDeviceRef.current) {
            await new Promise(r => setTimeout(r, 150));
            await connectRef.current();
          }
        } finally {
          resettingRef.current = false;
          setIsResetting(false);
        }
      })();
    }
  }, [activeTab, connected, disconnect]);

  // Persist active tab so F5 returns to the same view
  useEffect(() => {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(TAB_KEY, activeTab);
  }, [activeTab]);

  return (
    <div className="flex flex-col h-full bg-fob-surface text-fob-text font-mono text-xs select-none">
      {/* Status bar */}
      <div 
        className="flex items-center gap-2 px-3 border-b border-fob-border bg-fob-surface"
        style={{
          height: '53px',
        }}
      >
        <span className={`w-2 h-2 rounded-full ${serverOnline ? "bg-fob-green" : "bg-fob-border"}`} />
        <span className="text-fob-text-dim">{serverOnline ? "USB Bridge" : "Bridge offline"}</span>

        {/* Primary action: Connect / Disconnect — always same position */}
        {!connected ? (
          selectedDevice ? (
            <button
              onClick={connect}
              disabled={connState === "connecting"}
              className="px-2 py-1 rounded bg-fob-orange hover:bg-fob-orange/80 disabled:opacity-40 flex items-center justify-center"
            >
              {connState === "connecting" ? "Connecting…" : "Connect"}
            </button>
          ) : (
            <button disabled className="px-2 py-1 rounded bg-fob-surface disabled:opacity-40">Connect</button>
          )
        ) : (
          <button
            onClick={disconnect}
            className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-red flex items-center justify-center"
          >
            Disconnect
          </button>
        )}

        {/* Device info: dropdown when scanning, name when connected */}
        {!connected ? (
          <select
            className="bg-fob-surface border border-fob-border rounded px-1 py-1 text-xs text-fob-text flex items-center"
            value={selectedDevice ? `${selectedDevice.vid}:${selectedDevice.pid}` : ""}
            onChange={(e) => {
              const d = devices.find(d => `${d.vid}:${d.pid}` === e.target.value) ?? null;
              setSelectedDevice(d);
            }}
          >
            {devices.length === 0
              ? <option value="">No devices</option>
              : devices.map(d => (
                  <option key={`${d.vid}:${d.pid}`} value={`${d.vid}:${d.pid}`}>{d.name}</option>
                ))
            }
          </select>
        ) : (
          <span className="text-fob-orange font-bold">{selectedDevice?.name}</span>
        )}

        {/* Scan — only when not connected */}
        {!connected && serverOnline && (
          <button
            onClick={scan}
            disabled={scanning}
            className="px-2 py-1 rounded bg-fob-surface hover:bg-fob-border disabled:opacity-40 flex items-center justify-center"
          >
            {scanning ? "Scanning…" : "Scan"}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-fob-border">
        {(["la", "dso"] as Tab[]).map((tab) => {
          let disabledTitle: string | undefined;
          if (connected && tab === "dso" && selectedDevice?.mode === "la")
            disabledTitle = "Scope unavailable — unplug, press H/P button, replug for Scope mode";
          if (connected && tab === "la" && selectedDevice?.mode === "dso")
            disabledTitle = "Logic unavailable — unplug, release H/P button, replug for Logic mode";
          const disabled = !!disabledTitle;
          return (
            <button
              key={tab}
              onClick={() => !disabled && setActiveTab(tab)}
              title={disabledTitle}
              className={`px-4 py-1.5 text-xs uppercase tracking-wider border-b-2 transition-colors ${
                disabled
                  ? "border-transparent text-fob-text-dim cursor-not-allowed"
                  : activeTab === tab
                  ? "border-amber-500 text-amber-400"
                  : "border-transparent text-fob-text-dim hover:text-fob-text"
              }`}
            >
              {tab === "la" ? "Logic / Decode" : "Scope"}
            </button>
          );
        })}
      </div>

      {/* Views — all mounted, toggled with hidden */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div className={`absolute inset-0 ${activeTab === "la" ? "z-10" : "z-0 hidden"}`}>
          <WaveformLaView transport={transportRef.current} isActive={activeTab === "la"} connected={connected} />
        </div>
        <div className={`absolute inset-0 ${activeTab === "dso" ? "z-10" : "z-0 hidden"}`}>
          <WaveformDsoView transport={transportRef.current} isActive={activeTab === "dso"} connected={connected} resetting={isResetting} />
        </div>
      </div>
    </div>
  );
}

class WaveForgePlugin implements PluginLifecycle {
  private root: Root | null = null;

  mount(container: HTMLElement, bus: PluginBus): void {
    this.root = createRoot(container);
    this.root.render(<PluginErrorBoundary pluginId="waveforge"><WaveForgeApp bus={bus} /></PluginErrorBoundary>);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
    globalBus.emit("waveforge.usb.status", { connected: false, name: "" });
    resetSharedUsbTransport();
  }
}

export default function createPlugin(): PluginLifecycle {
  return new WaveForgePlugin();
}
