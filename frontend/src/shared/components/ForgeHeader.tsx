import { useState, useEffect, useRef } from "react";
import { useProjectStore } from "../../core/project_store";

interface ForgeHeaderProps {
  onToggleMenu: () => void;
  onOpenSettings: () => void;
  onOpenDashboard?: () => void;
}

function ProjectPill({ onOpenDashboard }: { onOpenDashboard?: () => void }) {
  const { active, defaultProject, projects, fetch, setActive, setDefault, createProject } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { fetch(); }, [fetch]);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative flex items-center w-full">
      {/* Split pill container */}
      <div className="flex w-full rounded-lg border border-fob-border bg-fob-surface overflow-hidden">
        {/* Left: project selector */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 px-4 py-1.5 text-sm font-mono font-bold text-fob-text hover:bg-fob-surface-hover hover:text-fob-orange transition-colors min-w-0"
        >
          <span className="text-fob-orange flex-shrink-0">📁</span>
          <span className="truncate">{active ?? "No project"}</span>
          {active === defaultProject && defaultProject && (
            <span title="Default project" className="text-fob-orange text-[10px] flex-shrink-0">★</span>
          )}
          <span className="text-fob-text-dim text-[9px] ml-1 flex-shrink-0">▼</span>
        </button>
        {/* Divider */}
        <div className="w-px bg-fob-border flex-shrink-0" />
        {/* Right: new project */}
        <button
          onClick={() => { setOpen(true); setCreating(true); }}
          title="New project"
          className="flex items-center justify-center px-3 text-fob-text-dim hover:bg-fob-surface-hover hover:text-fob-orange transition-colors flex-shrink-0 text-base font-bold"
        >
          +
        </button>
      </div>

      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-64 rounded-xl border border-fob-border bg-fob-surface shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-fob-text-dim border-b border-fob-border">
            Projects
          </div>
          <div className="max-h-52 overflow-y-auto">
            {projects.map((p) => (
              <div key={p.name} className={`flex items-center group transition-colors ${
                active === p.name ? "bg-fob-orange/10" : "hover:bg-fob-border"
              }`}>
                <button
                  onClick={() => { setActive(p.name); setOpen(false); onOpenDashboard?.(); }}
                  className={`flex-1 flex items-center gap-2 px-3 py-2 text-left text-xs ${
                    active === p.name ? "text-fob-orange font-bold" : "text-fob-text"
                  }`}
                >
                  <span>{active === p.name ? "📂" : "📁"}</span>
                  <span className="truncate font-mono">{p.name}</span>
                  {p.name === defaultProject && <span className="text-fob-orange text-[9px]">★</span>}
                  <span className="text-[9px] text-fob-text-dim flex-shrink-0 ml-auto">{p.notes}n · {p.captures}c</span>
                </button>
                <button
                  onClick={() => setDefault(p.name)}
                  title={p.name === defaultProject ? "Default project" : "Set as default"}
                  className={`px-2 py-2 text-[11px] opacity-0 group-hover:opacity-100 transition-opacity ${
                    p.name === defaultProject ? "text-fob-orange" : "text-fob-text-dim hover:text-fob-orange"
                  }`}
                >
                  ★
                </button>
              </div>
            ))}
          </div>
          {creating && (
            <div className="border-t border-fob-border p-2">
              <div className="flex gap-1">
                <input value={newName} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim()) {
                      const safe = newName.trim().replace(/[^a-zA-Z0-9\-_ ]/g, "").trim().replace(/ /g, "-") || "untitled";
                      createProject(safe); setCreating(false); setNewName(""); setOpen(false);
                    }
                    if (e.key === "Escape") { setCreating(false); setNewName(""); }
                  }}
                  autoFocus placeholder="project-name"
                  className="flex-1 rounded bg-fob-bg px-2 py-1 text-xs font-mono text-fob-text outline-none border border-fob-orange" />
                <button onClick={() => {
                  if (newName.trim()) {
                    const safe = newName.trim().replace(/[^a-zA-Z0-9\-_ ]/g, "").trim().replace(/ /g, "-") || "untitled";
                    createProject(safe); setCreating(false); setNewName(""); setOpen(false);
                  }
                }} className="rounded bg-fob-green text-fob-accent-text px-2 py-1 text-xs font-bold">✓</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HeaderClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = time.getHours().toString().padStart(2, "0");
  const mm = time.getMinutes().toString().padStart(2, "0");
  const ss = time.getSeconds().toString().padStart(2, "0");
  return (
    <div className="flex items-center px-3 font-mono text-sm text-fob-text-dim tabular-nums select-none">
      <span className="text-fob-orange">{hh}</span>
      <span className="text-fob-border mx-0.5">:</span>
      <span>{mm}</span>
      <span className="text-fob-border mx-0.5">:</span>
      <span className="text-[11px]">{ss}</span>
    </div>
  );
}

export function ForgeHeader({ onToggleMenu, onOpenSettings, onOpenDashboard }: ForgeHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <header className="flex items-stretch gap-1 bg-fob-bg px-1 pt-1 h-11 flex-shrink-0 relative z-30">
      {/* FOB pill — click for menu */}
      <div ref={menuRef} className="relative flex items-center">
        <button
          onClick={() => { setMenuOpen((v) => !v); onToggleMenu(); }}
          className={`flex items-center rounded-r-3xl px-4 py-2 text-sm font-bold uppercase tracking-widest transition-colors ${
            menuOpen ? "bg-fob-orange/80 text-fob-accent-text" : "bg-fob-orange text-fob-accent-text hover:bg-fob-orange/90"
          }`}
          title="Menu"
        >
          Forge Open Bench
          <span className="ml-2 text-[10px] opacity-60">{menuOpen ? "▲" : "▼"}</span>
        </button>

        {/* Dropdown from FOB pill */}
        {menuOpen && (
          <div className="absolute left-0 top-full mt-1 w-56 overflow-hidden rounded-b-xl rounded-r-xl border border-fob-border bg-fob-surface shadow-2xl z-50">
            <button
              onClick={() => { setMenuOpen(false); onOpenSettings(); }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-fob-text hover:bg-fob-border transition-colors"
            >
              ⚙ Settings
            </button>
            <button
              onClick={() => setMenuOpen(false)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-fob-text hover:bg-fob-border transition-colors"
            >
              ℹ About
            </button>
          </div>
        )}
      </div>

      {/* Center: project pill — wide, fills center zone */}
      <div className="flex-1 flex items-center justify-center px-2">
        <div className="w-full max-w-xl">
          <ProjectPill onOpenDashboard={onOpenDashboard} />
        </div>
      </div>

      {/* Right: clock */}
      <HeaderClock />
    </header>
  );
}
