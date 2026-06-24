import React from "react";
import { createRoot } from "react-dom/client";
import { useState, useMemo } from "react";
import { useSettingsStore } from "../../core/settings_store";
import { PLUGINS } from "../registry";
import type { PluginLifecycle, PluginBus } from "../types";

// ── Skin definitions ──────────────────────────────────────────────────────────
const SKINS = [
  { id: "forge-dark",  label: "Forge Dark",  bg: "#0A0A0F", accent: "#FF6600" },
  { id: "forge-light", label: "Forge Light", bg: "#F0F0F5", accent: "#FF6600" },
  { id: "lcars",       label: "LCARS",       bg: "#000000", accent: "#FF9900" },
  { id: "terminal",    label: "Terminal",    bg: "#0D1117", accent: "#00FF41" },
  { id: "midnight",    label: "Midnight",    bg: "#050510", accent: "#8866FF" },
];

export function applySkin(id: string) {
  document.documentElement.setAttribute("data-skin", id);
  localStorage.setItem("fob.skin", id);
}

// ── Settings schema ───────────────────────────────────────────────────────────

type ControlType = "text" | "select" | "checkbox" | "range" | "number";

interface SettingDef {
  id: string;
  block: string;
  key: string;
  title: string;
  description?: string;
  type: ControlType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: unknown;
  // Custom render overrides the generated control
  render?: (value: unknown, onChange: (value: unknown) => void) => React.ReactNode;
}

interface SettingsCategory {
  id: string;
  label: string;
  icon?: string;
  children?: SettingsCategory[];
  settings?: SettingDef[];
}

const CATEGORIES: SettingsCategory[] = [
  {
    id: "general",
    label: "General",
    icon: "⚙",
    settings: [
      {
        id: "ui.defaultPlugin",
        block: "ui",
        key: "defaultPlugin",
        title: "Startup plugin",
        description: "Which plugin opens when FOB launches.",
        type: "select",
        options: PLUGINS.map((p) => ({ value: p.id, label: `${p.icon} ${p.name}` })),
        defaultValue: "dashboard",
      },
      {
        id: "workspace.project_dir",
        block: "workspace",
        key: "project_dir",
        title: "Project directory",
        description: "Where projects and notes are stored.",
        type: "text",
        defaultValue: "~/Documents/Forge",
      },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: "🎨",
    settings: [
      {
        id: "ui.skin",
        block: "ui",
        key: "skin",
        title: "Skin",
        description: "Global color theme.",
        type: "select",
        options: SKINS.map((s) => ({ value: s.id, label: s.label })),
        defaultValue: "forge-dark",
        render: (value, onChange) => (
          <div className="grid grid-cols-3 gap-3 mt-2">
            {SKINS.map((s) => (
              <button
                key={s.id}
                onClick={() => { onChange(s.id); applySkin(s.id); }}
                className={`flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all ${
                  value === s.id
                    ? "border-fob-orange bg-fob-orange/10"
                    : "border-fob-border hover:border-fob-text-dim bg-fob-bg"
                }`}
              >
                <div className="w-12 h-8 rounded flex items-center justify-center gap-1" style={{ background: s.bg }}>
                  <div className="w-2 h-2 rounded-full" style={{ background: s.accent }} />
                  <div className="w-3 h-1 rounded-full" style={{ background: s.accent, opacity: 0.5 }} />
                </div>
                <span className={`text-[10px] font-mono font-bold ${value === s.id ? "text-fob-orange" : "text-fob-text-dim"}`}>
                  {s.label}
                </span>
              </button>
            ))}
          </div>
        ),
      },
    ],
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: "🔌",
    children: [
      {
        id: "plugins.core",
        label: "Core",
        settings: [
          {
            id: "plugins.enabled",
            block: "plugins",
            key: "__enabled_list",
            title: "Enabled plugins",
            description: "Toggle which plugins are available in the UI.",
            type: "checkbox",
            render: () => <PluginEnableList />,
          },
        ],
      },
      {
        id: "plugins.pocketforge",
        label: "PocketForge",
        settings: [
          {
            id: "pocketforge.preferredDevice",
            block: "pocketforge",
            key: "preferredDevice",
            title: "Preferred device",
            description: "Default device name to auto-connect.",
            type: "text",
            defaultValue: "",
          },
          {
            id: "pocketforge.autoConnectDevice",
            block: "pocketforge",
            key: "autoConnectDevice",
            title: "Auto-connect on startup",
            type: "checkbox",
            defaultValue: false,
          },
          {
            id: "pocketforge.intervalMs",
            block: "pocketforge",
            key: "intervalMs",
            title: "Update interval",
            description: "Meter sample refresh rate.",
            type: "range",
            min: 100,
            max: 2000,
            step: 100,
            defaultValue: 500,
          },
          {
            id: "pocketforge.tareSigma",
            block: "pocketforge",
            key: "tareSigma",
            title: "Tare σ",
            description: "Relative stability threshold for tare.",
            type: "range",
            min: 0.5,
            max: 3,
            step: 0.1,
            defaultValue: 2.0,
          },
          {
            id: "pocketforge.tareDeep",
            block: "pocketforge",
            key: "tareDeep",
            title: "Tare Deep",
            description: "Use a 200 mV floor for tare detection.",
            type: "checkbox",
            defaultValue: false,
          },
          {
            id: "pocketforge.autoFollow",
            block: "pocketforge",
            key: "autoFollow",
            title: "Auto-follow switch",
            description: "Follow the meter range switch automatically.",
            type: "checkbox",
            defaultValue: false,
          },
        ],
      },
      {
        id: "plugins.monitorforge",
        label: "MonitorForge",
        settings: [
          {
            id: "monitorforge.defaultBaud",
            block: "monitorforge",
            key: "defaultBaud",
            title: "Default baud rate",
            description: "Baud rate used when opening a new serial pane.",
            type: "number",
            defaultValue: 115200,
          },
          {
            id: "monitorforge.defaultMode",
            block: "monitorforge",
            key: "defaultMode",
            title: "Default display mode",
            type: "select",
            options: [
              { value: "ascii", label: "ASCII" },
              { value: "hex", label: "Hex" },
            ],
            defaultValue: "ascii",
          },
          {
            id: "monitorforge.showTimestamps",
            block: "monitorforge",
            key: "showTimestamps",
            title: "Show timestamps",
            description: "Prefix each received line with a timestamp.",
            type: "checkbox",
            defaultValue: true,
          },
        ],
      },
      {
        id: "plugins.noteforge",
        label: "NoteForge",
        settings: [
          {
            id: "noteforge.fontSize",
            block: "noteforge",
            key: "fontSize",
            title: "Editor font size",
            type: "range",
            min: 10,
            max: 20,
            step: 1,
            defaultValue: 14,
          },
          {
            id: "noteforge.defaultViewMode",
            block: "noteforge",
            key: "defaultViewMode",
            title: "Default view mode",
            type: "select",
            options: [
              { value: "edit", label: "Edit" },
              { value: "preview", label: "Preview" },
              { value: "split", label: "Split" },
            ],
            defaultValue: "edit",
          },
          {
            id: "noteforge.autoSave",
            block: "noteforge",
            key: "autoSave",
            title: "Auto-save notes",
            description: "Automatically save note changes after a short delay.",
            type: "checkbox",
            defaultValue: true,
          },
        ],
      },
      {
        id: "plugins.waveforge",
        label: "WaveForge",
        settings: [
          {
            id: "waveforge.defaultDevice",
            block: "waveforge",
            key: "defaultDevice",
            title: "Preferred device",
            description: "Preferred sigrok device pattern.",
            type: "text",
            defaultValue: "",
          },
        ],
      },
      {
        id: "plugins.lensforge",
        label: "LensForge",
        settings: [
          {
            id: "lensforge.defaultCamera",
            block: "lensforge",
            key: "defaultCamera",
            title: "Preferred camera",
            description: "Default camera deviceId or label.",
            type: "text",
            defaultValue: "",
          },
          {
            id: "lensforge.recordingQuality",
            block: "lensforge",
            key: "recordingQuality",
            title: "Recording quality",
            type: "select",
            options: [
              { value: "low", label: "Low (webm / VP8)" },
              { value: "medium", label: "Medium (webm / VP9)" },
              { value: "high", label: "High (webm / VP9, high bitrate)" },
            ],
            defaultValue: "medium",
          },
        ],
      },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: "ℹ",
    settings: [
      {
        id: "system.version",
        block: "__readonly",
        key: "version",
        title: "Version",
        type: "text",
        render: () => <ReadOnlyValue path="version" />,
      },
      {
        id: "system.runtime",
        block: "__readonly",
        key: "runtime",
        title: "Runtime",
        type: "text",
        render: () => <span className="text-xs font-mono text-fob-text">{navigator.userAgent.includes("Firefox") ? "Firefox" : "Chromium"}</span>,
      },
      {
        id: "system.platform",
        block: "__readonly",
        key: "platform",
        title: "Platform",
        type: "text",
        render: () => <span className="text-xs font-mono text-fob-text">Local · {window.location.host}</span>,
      },
      {
        id: "system.shortcuts",
        block: "__readonly",
        key: "shortcuts",
        title: "Keyboard shortcuts",
        type: "text",
        render: () => <ShortcutsTable />,
      },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function useConfigValue(block: string, key: string, defaultValue?: unknown) {
  const config = useSettingsStore((s) => s.config);
  if (block === "__readonly") return defaultValue;
  const blockObj = (config?.[block] as Record<string, unknown> | undefined) ?? {};
  return blockObj[key] ?? defaultValue;
}

function useConfigSetter(block: string) {
  const updateBlock = useSettingsStore((s) => s.updateBlock);
  return (key: string, value: unknown) => {
    if (block === "__readonly") return;
    const config = useSettingsStore.getState().config;
    const blockObj = (config?.[block] as Record<string, unknown> | undefined) ?? {};
    updateBlock(block, { ...blockObj, [key]: value });
  };
}

// ── Controls ──────────────────────────────────────────────────────────────────

function SettingControl({ def }: { def: SettingDef }) {
  const value = useConfigValue(def.block, def.key, def.defaultValue);
  const set = useConfigSetter(def.block);

  if (def.render) {
    return def.render(value, (v) => set(def.key, v));
  }

  const onChange = (v: unknown) => set(def.key, v);

  switch (def.type) {
    case "text":
      return (
        <input
          type="text"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="settings-input w-full max-w-md"
          spellCheck={false}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={(value as number) ?? 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="settings-input w-32"
        />
      );
    case "select":
      return (
        <select
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="settings-select w-full max-w-md"
        >
          {def.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      );
    case "checkbox":
      return (
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="settings-check"
          />
          <span className="text-xs font-mono text-fob-text-dim">Enabled</span>
        </label>
      );
    case "range":
      return (
        <div className="flex items-center gap-3 w-full max-w-md">
          <input
            type="range"
            min={def.min}
            max={def.max}
            step={def.step}
            value={Number(value ?? def.defaultValue ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1 accent-fob-orange"
          />
          <span className="text-xs font-mono text-fob-orange w-16 text-right">{value as number}</span>
        </div>
      );
    default:
      return null;
  }
}

function ReadOnlyValue({ path }: { path: string }) {
  const config = useSettingsStore((s) => s.config);
  const value = (config?.[path] as string) ?? "—";
  return <span className="text-xs font-mono text-fob-orange">{value}</span>;
}

function ShortcutsTable() {
  return (
    <div className="settings-card">
      <table className="w-full text-[11px] font-mono">
        <tbody className="divide-y divide-fob-border/30">
          {[
            ["Ctrl+1–6", "Switch plugin (Dashboard, Pocket, Wave, Lens, Notes, Monitor)"],
            ["Ctrl+B", "Toggle sidebar"],
            ["Ctrl+'", "Toggle bottom panel (Shell / Events / Logs / Serial)"],
            ["Ctrl+Shift+E", "Toggle file tree"],
            ["Ctrl+,", "Open settings"],
            ["H / R", "PocketForge meter Hold / REL"],
          ].map(([key, desc]) => (
            <tr key={key}>
              <td className="py-1 pr-4 text-fob-orange">{key}</td>
              <td className="py-1 text-fob-text-dim">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PluginEnableList() {
  const config = useSettingsStore((s) => s.config);
  const updateBlock = useSettingsStore((s) => s.updateBlock);
  const plugins = (config?.plugins as Record<string, { enabled?: boolean }> | undefined) ?? {};

  const toggle = (id: string) => {
    const current = plugins[id] ?? { enabled: true };
    updateBlock("plugins", { ...plugins, [id]: { ...current, enabled: !current.enabled } });
  };

  return (
    <div className="space-y-2">
      {PLUGINS.map((p) => {
        const enabled = plugins[p.id]?.enabled !== false;
        return (
          <div key={p.id} className="settings-card flex items-center gap-3">
            <label className="flex items-center gap-3 cursor-pointer flex-1">
              <input
                type="checkbox"
                checked={enabled}
                onChange={() => toggle(p.id)}
                className="settings-check"
              />
              <span className="text-lg leading-none">{p.icon}</span>
              <span className="text-sm font-mono text-fob-text">{p.name}</span>
            </label>
            <span className="text-[10px] font-mono text-fob-text-dim">{p.id}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Tree navigation ─────────────────────────────────────────────────────────────

function collectAllDefs(categories: SettingsCategory[]): SettingDef[] {
  const out: SettingDef[] = [];
  for (const cat of categories) {
    if (cat.settings) out.push(...cat.settings);
    if (cat.children) out.push(...collectAllDefs(cat.children));
  }
  return out;
}

function flattenCategories(categories: SettingsCategory[]): SettingsCategory[] {
  const out: SettingsCategory[] = [];
  for (const cat of categories) {
    out.push(cat);
    if (cat.children) out.push(...flattenCategories(cat.children));
  }
  return out;
}

function searchMatches(def: SettingDef, query: string): boolean {
  const q = query.toLowerCase();
  return (
    def.title.toLowerCase().includes(q) ||
    (def.description?.toLowerCase().includes(q) ?? false) ||
    def.id.toLowerCase().includes(q)
  );
}

// ── Tree sidebar item ─────────────────────────────────────────────────────────

function TreeItem({
  category,
  level,
  activeId,
  expanded,
  onSelect,
  onToggleExpand,
}: {
  category: SettingsCategory;
  level: number;
  activeId: string | null;
  expanded: Set<string>;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
}) {
  const hasChildren = !!category.children?.length;
  const isExpanded = expanded.has(category.id);
  const isActive = activeId === category.id;
  const indent = level * 12 + 8;

  return (
    <div>
      <button
        onClick={() => {
          if (hasChildren) onToggleExpand(category.id);
          onSelect(category.id);
        }}
        className={`w-full flex items-center gap-1.5 pr-2 py-1.5 text-xs font-mono text-left transition-colors ${
          isActive
            ? "bg-fob-orange/10 text-fob-orange border-r-2 border-fob-orange"
            : "text-fob-text-dim hover:text-fob-text hover:bg-fob-surface"
        }`}
        style={{ paddingLeft: `${indent}px` }}
      >
        {hasChildren && (
          <span className="text-[10px] w-3 text-center transition-transform">
            {isExpanded ? "▼" : "▶"}
          </span>
        )}
        {!hasChildren && <span className="text-[10px] w-3 text-center">{category.icon || "•"}</span>}
        <span className="truncate">{category.label}</span>
      </button>
      {hasChildren && isExpanded && (
        <div>
          {category.children!.map((child) => (
            <TreeItem
              key={child.id}
              category={child}
              level={level + 1}
              activeId={activeId}
              expanded={expanded}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Settings view ──────────────────────────────────────────────────────────

function SettingsView() {
  const [activeId, setActiveId] = useState<string>("general");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["plugins"]));
  const [query, setQuery] = useState("");

  const flatCategories = useMemo(() => flattenCategories(CATEGORIES), []);
  const allDefs = useMemo(() => collectAllDefs(CATEGORIES), []);

  const activeCategory = flatCategories.find((c) => c.id === activeId) ?? CATEGORIES[0];
  const isSearching = query.trim().length > 0;

  const visibleDefs = useMemo(() => {
    if (!isSearching) {
      const cat = activeCategory;
      const defs: SettingDef[] = [];
      if (cat.settings) defs.push(...cat.settings);
      // If a category with children is selected and has no direct settings, show all children settings
      if (!cat.settings && cat.children) {
        for (const child of cat.children) {
          if (child.settings) defs.push(...child.settings);
        }
      }
      return defs;
    }
    return allDefs.filter((d) => searchMatches(d, query));
  }, [activeCategory, allDefs, query, isSearching]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="h-full flex bg-fob-surface">
      {/* Left sidebar — VS Code settings style */}
      <aside className="w-52 flex-shrink-0 border-r border-fob-border bg-fob-bg flex flex-col">
        <div className="px-3 py-2 border-b border-fob-border">
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-fob-orange mb-2">
            Settings
          </div>
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              className="w-full bg-fob-surface text-fob-text text-xs font-mono px-2 py-1.5 rounded border border-fob-border outline-none focus:border-fob-orange"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fob-text-dim hover:text-fob-text text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto py-1">
          {CATEGORIES.map((cat) => (
            <TreeItem
              key={cat.id}
              category={cat}
              level={0}
              activeId={activeId}
              expanded={expanded}
              onSelect={setActiveId}
              onToggleExpand={toggleExpand}
            />
          ))}
        </nav>
      </aside>

      {/* Right content area */}
      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="max-w-3xl mx-auto p-6">
          <h2 className="text-sm font-mono font-bold uppercase tracking-widest text-fob-orange mb-5">
            {isSearching ? `Search: "${query}"` : activeCategory.label}
          </h2>

          {visibleDefs.length === 0 ? (
            <div className="text-xs font-mono text-fob-text-dim">
              No settings match your search.
            </div>
          ) : (
            <div className="space-y-6">
              {visibleDefs.map((def) => (
                <div key={def.id} className="settings-card">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono font-bold text-fob-text">{def.title}</div>
                      {def.description && (
                        <div className="text-[10px] font-mono text-fob-text-dim mt-1 leading-relaxed max-w-md">
                          {def.description}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      <SettingControl def={def} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── PluginLifecycle wrapper ───────────────────────────────────────────────────
class SettingsPlugin implements PluginLifecycle {
  private root: ReturnType<typeof createRoot> | null = null;

  mount(container: HTMLElement, _bus: PluginBus): void {
    this.root = createRoot(container);
    this.root.render(<SettingsView />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}

export default new SettingsPlugin();
