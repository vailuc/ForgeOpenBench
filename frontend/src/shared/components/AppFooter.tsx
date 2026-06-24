import { useState, useRef, useEffect } from "react";

export interface FooterAction {
  label: string;
  variant?: "default" | "danger" | "primary";
  onClick: () => void;
}

export interface FooterItem {
  id: string;
  label: string;
  color: string;
  active: boolean;
  detail?: string;
  pluginId?: string;
  actions?: FooterAction[];
}

type PanelTab = "shell" | "events" | "logs" | "serial";

interface AppFooterProps {
  items: FooterItem[];
  bottomPanelOpen: boolean;
  activeTab: PanelTab;
  onToggleBottomPanel: () => void;
  onSelectTab: (tab: PanelTab) => void;
  onNavigate: (pluginId: string) => void;
}

function StatusPopover({ item, onClose, onNavigate }: { item: FooterItem; onClose: () => void; onNavigate: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const variantClass = (v?: FooterAction["variant"]) => {
    if (v === "danger") return "hover:text-fob-red hover:bg-fob-red/10";
    if (v === "primary") return "hover:text-fob-orange hover:bg-fob-orange/10";
    return "hover:text-fob-text hover:bg-fob-border/30";
  };

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 left-0 min-w-[180px] rounded-lg border border-fob-border bg-fob-surface shadow-2xl z-50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-fob-border flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${item.color} ${item.active ? "animate-pulse" : ""}`} />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-fob-text flex-1">{item.label}</span>
      </div>
      {/* Status line */}
      <div className="px-3 py-1.5 text-[10px] font-mono text-fob-text-dim border-b border-fob-border/50">
        {item.detail ?? (item.active ? "Connected" : "Offline — not started")}
      </div>
      {/* Actions */}
      {(item.actions ?? []).map((a) => (
        <button key={a.label} onClick={() => { a.onClick(); onClose(); }}
          className={`w-full text-left px-3 py-1.5 text-[10px] font-mono text-fob-text-dim transition-colors ${variantClass(a.variant)}`}
        >{a.label}</button>
      ))}
      {item.pluginId && (
        <button onClick={() => { onNavigate(item.pluginId!); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-fob-text-dim hover:text-fob-orange hover:bg-fob-orange/10 transition-colors border-t border-fob-border/50"
        >→ Open {item.label.split(":")[0]}</button>
      )}
    </div>
  );
}

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "shell", label: ">_ Shell" },
  { id: "events", label: "⚡ Events" },
  { id: "logs", label: "📋 Logs" },
  { id: "serial", label: "⎆ Serial" },
];

export function AppFooter({ items, bottomPanelOpen, activeTab, onToggleBottomPanel, onSelectTab, onNavigate }: AppFooterProps) {
  const [openPopover, setOpenPopover] = useState<string | null>(null);

  return (
    <footer className="flex items-stretch gap-0 bg-fob-bg border-t border-fob-border px-1 h-9 flex-shrink-0 z-20">
      {/* Status pills — left side */}
      <div className="flex items-center gap-0.5 px-1">
        {items.map((item) => (
          <div key={item.id} className="relative">
            <button
              onClick={() => setOpenPopover(openPopover === item.id ? null : item.id)}
              className="flex items-center gap-2 rounded-md px-2.5 h-7 text-[11px] font-mono font-bold uppercase tracking-wide text-fob-text-dim hover:bg-fob-surface hover:text-fob-text transition-colors min-w-[44px] justify-center"
            >
              <span className={`h-2 w-2 rounded-full flex-shrink-0 ${item.color} ${item.active ? "animate-pulse" : ""}`} />
              <span className="hidden sm:inline">{item.label}</span>
            </button>
            {openPopover === item.id && (
              <StatusPopover item={item} onClose={() => setOpenPopover(null)} onNavigate={onNavigate} />
            )}
          </div>
        ))}
      </div>

      <div className="flex-1" />

      {/* Shell / Events tabs — right side, always visible */}
      <div className="flex items-stretch border-l border-fob-border">
        {PANEL_TABS.map((tab) => {
          const isActive = bottomPanelOpen && activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                if (bottomPanelOpen && activeTab === tab.id) {
                  onToggleBottomPanel();
                } else {
                  onSelectTab(tab.id);
                  if (!bottomPanelOpen) onToggleBottomPanel();
                }
              }}
              className={`flex items-center gap-1.5 px-4 text-[11px] font-mono font-bold uppercase tracking-wide transition-colors ${
                isActive
                  ? "text-fob-orange border-t-2 border-fob-orange bg-fob-surface"
                  : "text-fob-text-dim hover:bg-fob-surface hover:text-fob-text border-t-2 border-transparent"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </footer>
  );
}
