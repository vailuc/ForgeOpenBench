import { PluginErrorBoundary } from "../../shared/components/PluginErrorBoundary";
import type { PluginLifecycle, PluginBus } from "../types";
import { createRoot, type Root } from "react-dom/client";
import { useState, useEffect, useRef, useCallback } from "react";
import { MultimeterView } from "./MultimeterView";
import { OscilloscopeView } from "./OscilloscopeView";
import { LoggerView } from "./LoggerView";
import { LogicAnalyzerView } from "./LogicAnalyzerView";
import { getSharedTransport, setSharedTransport } from "./sharedTransport";
import { BleTransport } from "./BleTransport";
import { BridgeTransport } from "./BridgeTransport";
import { toast } from "../../shared/hooks/useToastStore";
import { globalBus } from "../../core/global_bus";
import { useSettingsStore } from "../../core/settings_store";

type Tab = "meter" | "datalog" | "dso" | "logic";

const TABS: { key: Tab; label: string }[] = [
  { key: "meter", label: "Meter" },
  { key: "datalog", label: "Data Log" },
  { key: "dso", label: "DSO" },
  { key: "logic", label: "Logic" },
];

type TransportType = "web" | "bridge";
type ConnectionState = "disconnected" | "connecting" | "connected";


// Shared connection state hook
function useConnectionState() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [deviceName, setDeviceName] = useState("");

  useEffect(() => {
    const checkTransport = () => {
      const t = getSharedTransport();
      if (t && t.isConnected) {
        setConnectionState("connected");
        setDeviceName(t.deviceName);
      } else {
        setConnectionState("disconnected");
        setDeviceName("");
      }
    };
    checkTransport();
    const interval = setInterval(checkTransport, 500);
    return () => clearInterval(interval);
  }, []);

  return { connectionState, deviceName };
}


function ConnectionStatus() {
  const { connectionState, deviceName } = useConnectionState();
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";

  if (!isConnected && !isConnecting) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
        isConnected ? "bg-fob-green animate-pulse" : "bg-fob-orange animate-ping"
      }`} />
      <span className={`text-xs font-mono font-bold ${
        isConnected ? "text-fob-green" : "text-fob-orange"
      }`}>
        {isConnected ? (deviceName || "Connected") : "Connecting…"}
      </span>
    </div>
  );
}

function ConnectionControls() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const transportType = useSettingsStore((s) => s.pluginTransport["pocketforge"] ?? "web") as TransportType;
  const transportRef = useRef<BleTransport | BridgeTransport | null>(getSharedTransport() as BleTransport | BridgeTransport | null);

  useEffect(() => {
    const checkTransport = () => {
      const t = getSharedTransport();
      if (t && t.isConnected) setConnectionState("connected");
      else setConnectionState("disconnected");
    };
    checkTransport();
    const interval = setInterval(checkTransport, 500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return globalBus.on("pocketforge.transport.set", (payload) => {
      const { transport } = payload as { transport: TransportType };
      if (transport === "web" || transport === "bridge") {
        useSettingsStore.getState().setPluginTransport("pocketforge", transport);
      }
    });
  }, []);

  const connect = useCallback(async () => {
    setConnectionState("connecting");
    try {
      // If a transport from the other mode is still active, disconnect it first
      // so the device is free for the new connection (Web BT <-> PyBT handover).
      const existing = getSharedTransport();
      if (existing) {
        existing.disconnect();
        setSharedTransport(null);
        await new Promise((r) => setTimeout(r, 300));
      }

      const t = transportType === "web" ? new BleTransport() : new BridgeTransport();
      transportRef.current = t;
      setSharedTransport(t);
      await t.requestAndConnect();
      setConnectionState("connected");
      toast.success(`Connected: ${t.deviceName}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnectionState("disconnected");
      toast.error(msg);
    }
  }, [transportType]);

  const disconnect = useCallback(() => {
    transportRef.current?.disconnect();
    transportRef.current = null;
    setSharedTransport(null);
    setConnectionState("disconnected");
    useSettingsStore.getState().setPluginConnected("pocketforge", false);
    toast.info("Disconnected");
  }, []);

  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={isConnected ? disconnect : connect}
        disabled={isConnecting}
        title={isConnected ? "Disconnect" : `Connect via ${transportType === "web" ? "Web BT" : "Bridge"}`}
        className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${
          isConnected
            ? "border-fob-red/60 bg-fob-red/10 hover:bg-fob-red/20 text-fob-red"
            : isConnecting
            ? "border-fob-orange/40 bg-fob-orange/5 text-fob-orange cursor-wait animate-pulse"
            : "border-fob-border bg-fob-bg hover:border-fob-orange hover:bg-fob-orange/10 text-fob-text-dim hover:text-fob-orange"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 2v6"/>
          <path d="M6.34 6.34a9 9 0 1 0 11.32 0"/>
        </svg>
      </button>
    </div>
  );
}

function PocketForgeView({ bus }: { bus: PluginBus }) {
  const [activeTab, setActiveTab] = useState<Tab>("meter");

  return (
    <div className="h-full bg-fob-surface relative flex flex-col">
      {/* Sub-tabs + Connection Controls + Centered Status */}
      <div 
        className="flex items-center gap-1 px-2 border-b border-fob-border"
        style={{
          height: '53px',
        }}
      >
        {/* Leftmost: Power Button */}
        <ConnectionControls />
        
        {/* Left: Tabs */}
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-3 py-1.5 rounded-t text-xs font-bold transition-colors flex items-center justify-center ${
                activeTab === t.key
                  ? "bg-fob-surface text-fob-orange border-t border-x border-fob-border border-b-transparent"
                  : "text-fob-text-dim hover:text-fob-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Center: Connection Status */}
        <div className="flex-1 flex items-center justify-center">
          <ConnectionStatus />
        </div>
        
        {/* Right: Empty space to avoid FOB header */}
        <div className="w-32"></div>
      </div>

      {/* View content — all tabs stay mounted, toggle visibility */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div className={`absolute inset-0 ${activeTab === "meter" ? "z-10" : "z-0 hidden"}`}>
          <MultimeterView bus={bus} isActive={activeTab === "meter" || activeTab === "datalog"} />
        </div>
        <div className={`absolute inset-0 ${activeTab === "datalog" ? "z-10" : "z-0 hidden"}`}>
          <LoggerView bus={bus} isActive={activeTab === "datalog"} />
        </div>
        <div className={`absolute inset-0 ${activeTab === "dso" ? "z-10" : "z-0 hidden"}`}>
          <OscilloscopeView bus={bus} isActive={activeTab === "dso"} />
        </div>
        <div className={`absolute inset-0 ${activeTab === "logic" ? "z-10" : "z-0 hidden"}`}>
          <LogicAnalyzerView bus={bus} isActive={activeTab === "logic"} />
        </div>
      </div>
    </div>
  );
}

class PocketForgePlugin implements PluginLifecycle {
  private root: Root | null = null;

  mount(container: HTMLElement, bus: PluginBus): void {
    if (!this.root) {
      this.root = createRoot(container);
    }
    this.root.render(<PluginErrorBoundary pluginId="pocketforge"><PocketForgeView bus={bus} /></PluginErrorBoundary>);
  }

  unmount(): void {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}

export default function createPocketForgePlugin(): PluginLifecycle {
  return new PocketForgePlugin();
}
