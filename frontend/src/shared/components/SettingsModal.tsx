import { useState } from "react";
import { useSettingsStore } from "../../core/settings_store";
import { PLUGINS } from "../../plugins/registry";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const config = useSettingsStore((s) => s.config);
  const updateBlock = useSettingsStore((s) => s.updateBlock);

  if (!open) return null;

  const workspace = (config?.workspace as Record<string, unknown> | undefined) ?? {
    project_dir: "~/Documents/Forge",
  };

  const plugins = (config?.plugins as Record<string, Record<string, unknown>> | undefined) ?? {};
  const ui = (config?.ui as Record<string, unknown> | undefined) ?? {};
  const pocketforge = (config?.pocketforge as Record<string, unknown> | undefined) ?? {};

  const handleDirChange = (value: string) => {
    updateBlock("workspace", { ...workspace, project_dir: value });
  };

  const togglePlugin = (id: string) => {
    const current = plugins[id] ?? { enabled: true };
    updateBlock("plugins", {
      ...plugins,
      [id]: { ...current, enabled: !current.enabled },
    });
  };

  const setDefaultPlugin = (id: string) => {
    updateBlock("ui", { ...ui, defaultPlugin: id });
  };

  const setPocketforgePref = (key: string, value: unknown) => {
    updateBlock("pocketforge", { ...pocketforge, [key]: value });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-fob-surface border-2 border-fob-border rounded-lg w-[28rem] max-w-[90vw] p-5 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5 border-b border-fob-border pb-2">
          <span className="font-mono text-sm font-bold text-fob-orange tracking-wider">
            FORGE SETTINGS
          </span>
          <button
            onClick={onClose}
            className="text-fob-text-dim hover:text-fob-text font-mono text-xs px-2 py-1"
          >
            [x]
          </button>
        </div>

        {/* Startup */}
        <div className="mb-5">
          <div className="text-[10px] uppercase text-fob-text-dim font-mono mb-1.5 tracking-wider">
            Startup
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-fob-text">Default tab:</span>
            <select
              value={(ui.defaultPlugin as string) || "noteforge"}
              onChange={(e) => setDefaultPlugin(e.target.value)}
              className="bg-fob-bg text-fob-text font-mono text-xs p-1.5 border border-fob-border rounded outline-none focus:border-fob-orange flex-1"
            >
              {PLUGINS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Workspace */}
        <div className="mb-5">
          <div className="text-[10px] uppercase text-fob-text-dim font-mono mb-1.5 tracking-wider">
            Workspace
          </div>
          <input
            type="text"
            value={workspace.project_dir as string}
            onChange={(e) => handleDirChange(e.target.value)}
            className="w-full bg-fob-bg text-fob-text font-mono text-xs p-2 border border-fob-border rounded outline-none focus:border-fob-orange transition-colors"
            spellCheck={false}
          />
          <div className="text-[10px] text-fob-text-dim font-mono mt-1">
            Notes stored in: {workspace.project_dir as string}/notes
          </div>
        </div>

        {/* PocketForge */}
        <div className="mb-5">
          <div className="text-[10px] uppercase text-fob-text-dim font-mono mb-2 tracking-wider">
            PocketForge
          </div>
          <div className="space-y-2 bg-fob-bg border border-fob-border rounded p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-fob-text w-28">Preferred device:</span>
              <input
                type="text"
                value={(pocketforge.preferredDevice as string) || ""}
                onChange={(e) => setPocketforgePref("preferredDevice", e.target.value)}
                placeholder="Device name (e.g. My Pokit)"
                className="flex-1 bg-fob-surface text-fob-text font-mono text-xs p-1.5 border border-fob-border rounded outline-none focus:border-fob-orange"
                spellCheck={false}
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!pocketforge.autoConnectDevice}
                onChange={(e) => setPocketforgePref("autoConnectDevice", e.target.checked)}
                className="accent-fob-orange w-3.5 h-3.5"
              />
              <span className="text-xs font-mono text-fob-text">Auto-connect to preferred device on startup</span>
            </label>
            <div className="border-t border-fob-border pt-2 mt-1">
              <div className="text-[10px] uppercase text-fob-text-dim font-mono mb-1.5 tracking-wider">Meter Defaults</div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-fob-text w-20">Tare σ:</span>
                  <input
                    type="range" min={0.5} max={3} step={0.1}
                    value={(pocketforge.tareSigma as number) ?? 2.0}
                    onChange={(e) => setPocketforgePref("tareSigma", Number(e.target.value))}
                    className="flex-1 accent-fob-orange"
                  />
                  <span className="text-xs font-mono text-fob-text w-8 text-right">{((pocketforge.tareSigma as number) ?? 2.0).toFixed(1)}</span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!pocketforge.tareDeep}
                    onChange={(e) => setPocketforgePref("tareDeep", e.target.checked)}
                    className="accent-fob-orange w-3.5 h-3.5"
                  />
                  <span className="text-xs font-mono text-fob-text">Tare Deep (200 mV floor)</span>
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-fob-text w-20">Interval:</span>
                  <input
                    type="range" min={100} max={2000} step={100}
                    value={(pocketforge.intervalMs as number) ?? 500}
                    onChange={(e) => setPocketforgePref("intervalMs", Number(e.target.value))}
                    className="flex-1 accent-fob-orange"
                  />
                  <span className="text-xs font-mono text-fob-text w-10 text-right">{((pocketforge.intervalMs as number) ?? 500)}ms</span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!pocketforge.autoFollow}
                    onChange={(e) => setPocketforgePref("autoFollow", e.target.checked)}
                    className="accent-fob-orange w-3.5 h-3.5"
                  />
                  <span className="text-xs font-mono text-fob-text">Auto-follow switch</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Plugins */}
        <div className="mb-5">
          <div className="text-[10px] uppercase text-fob-text-dim font-mono mb-2 tracking-wider">
            Plugins
          </div>
          <div className="space-y-1">
            {PLUGINS.map((p) => {
              const enabled = (plugins[p.id]?.enabled as boolean | undefined) ?? true;
              const isExpanded = expandedPlugin === p.id;
              const pluginConfig = plugins[p.id] ?? {};
              return (
                <div key={p.id} className="border border-fob-border rounded overflow-hidden">
                  {/* Row */}
                  <div className="flex items-center justify-between p-1.5 hover:bg-fob-bg transition-colors">
                    <label className="flex items-center gap-3 cursor-pointer flex-1">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => togglePlugin(p.id)}
                        className="accent-fob-orange w-3.5 h-3.5"
                      />
                      <span className="text-lg leading-none">{p.icon}</span>
                      <span className="text-xs font-mono text-fob-text">{p.name}</span>
                    </label>
                    <button
                      onClick={() => setExpandedPlugin(isExpanded ? null : p.id)}
                      className="text-[10px] font-mono text-fob-text-dim hover:text-fob-orange px-2 transition-colors"
                    >
                      {isExpanded ? "▲ hide" : "▸ details"}
                    </button>
                  </div>

                  {/* Detail panel */}
                  {isExpanded && (
                    <div className="border-t border-fob-border bg-fob-bg p-2 space-y-2">
                      <div className="text-[10px] font-mono text-fob-text-dim">
                        ID: <span className="text-fob-orange">{p.id}</span>
                      </div>
                      <div className="text-[10px] font-mono text-fob-text-dim">
                        Config:
                      </div>
                      <pre className="bg-black/30 rounded p-2 text-[10px] font-mono text-fob-text overflow-auto max-h-24">
                        {JSON.stringify(pluginConfig, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* System */}
        <div className="mb-2">
          <div className="text-[10px] uppercase text-fob-text-dim font-mono mb-1.5 tracking-wider">
            System
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-fob-bg border border-fob-border rounded p-2">
              <div className="text-[10px] text-fob-text-dim font-mono">Theme</div>
              <div className="text-xs font-mono text-fob-text">dark</div>
            </div>
            <div className="bg-fob-bg border border-fob-border rounded p-2">
              <div className="text-[10px] text-fob-text-dim font-mono">Version</div>
              <div className="text-xs font-mono text-fob-text">
                {(config?.version as string) ?? "1.0.0"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
