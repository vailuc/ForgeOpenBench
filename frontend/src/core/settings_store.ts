import { create } from "zustand";
import { eventBus } from "./event_bus";

const LS_PLUGIN_TRANSPORT = "fob.pluginTransport";

function loadPluginTransport(): Record<string, "web" | "bridge"> {
  try {
    const raw = localStorage.getItem(LS_PLUGIN_TRANSPORT);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function savePluginTransport(transports: Record<string, "web" | "bridge">): void {
  try {
    localStorage.setItem(LS_PLUGIN_TRANSPORT, JSON.stringify(transports));
  } catch { /* ignore */ }
}

interface SettingsState {
  config: Record<string, unknown> | null;
  connected: boolean;
  pluginConnected: Record<string, boolean>;
  pluginTransport: Record<string, "web" | "bridge">;
  setConfig: (config: Record<string, unknown>) => void;
  updateBlock: (key: string, payload: Record<string, unknown>) => void;
  setConnected: (connected: boolean) => void;
  setPluginConnected: (id: string, connected: boolean) => void;
  setPluginTransport: (id: string, transport: "web" | "bridge") => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  config: null,
  connected: false,
  pluginConnected: {},
  pluginTransport: loadPluginTransport(),

  setConfig: (config) => set({ config, connected: true }),

  updateBlock: (key, payload) => {
    eventBus.send({ type: "settings_update", key, payload });
    // Optimistically update local state
    set((state) => ({
      config: state.config ? { ...state.config, [key]: payload } : { [key]: payload },
    }));
  },

  setConnected: (connected) => set({ connected }),

  setPluginConnected: (id, connected) =>
    set((state) => ({
      pluginConnected: { ...state.pluginConnected, [id]: connected },
    })),

  setPluginTransport: (id, transport) =>
    set((state) => {
      const next = { ...state.pluginTransport, [id]: transport };
      savePluginTransport(next);
      return { pluginTransport: next };
    }),
}));

// Wire up EventBus → Zustand store
eventBus.onMessage((msg) => {
  if (msg.type === "settings_snapshot") {
    useSettingsStore.getState().setConfig(msg.payload);
  } else if (msg.type === "settings_ack") {
    if (msg.status === "error") {
      console.error("[SettingsStore] Server rejected update:", msg.reason);
    }
  }
});
