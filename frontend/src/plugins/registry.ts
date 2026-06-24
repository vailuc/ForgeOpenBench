import type { PluginDescriptor, PluginLifecycle, PluginBus } from "./types";

function resolvePlugin(def: unknown): PluginLifecycle {
  if (typeof def === "function") {
    const isClass = def.prototype && typeof def.prototype.mount === "function";
    return isClass
      ? new (def as new () => PluginLifecycle)()
      : (def as () => PluginLifecycle)();
  }
  return def as PluginLifecycle;
}

const PLUGINS: PluginDescriptor[] = [
  {
    id: "dashboard",
    name: "Home",
    icon: "🏠",
    load: async () => {
      const mod = await import("./dashboard");
      return { default: resolvePlugin(mod.default) };
    },
  },
  {
    id: "pocketforge",
    name: "Pocket",
    icon: "⚡",
    load: async () => {
      const mod = await import("./pocketforge");
      return { default: resolvePlugin(mod.default) };
    },
  },
  {
    id: "waveforge",
    name: "Wave",
    icon: "📊",
    load: async () => {
      const mod = await import("./waveforge");
      return { default: resolvePlugin(mod.default) };
    },
  },
  {
    id: "lensforge",
    name: "Lens",
    icon: "🔬",
    load: async () => {
      const mod = await import("./lensforge");
      return { default: resolvePlugin(mod.default) };
    },
  },
  {
    id: "noteforge",
    name: "Notes",
    icon: "📝",
    load: async () => {
      const mod = await import("./noteforge");
      return { default: resolvePlugin(mod.default) };
    },
  },
  {
    id: "monitorforge",
    name: "Monitor",
    icon: "⎆",
    load: async () => {
      const mod = await import("./monitorforge");
      return { default: resolvePlugin(mod.default) };
    },
  },
];

const SETTINGS_PLUGIN = {
  id: "settings",
  name: "Settings",
  icon: "⚙",
  load: async () => {
    const mod = await import("./settings");
    return { default: resolvePlugin(mod.default) };
  },
};

class SimpleBus implements PluginBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}

export { PLUGINS, SETTINGS_PLUGIN, SimpleBus };
export type { PluginLifecycle, PluginBus };
