import { useState, useEffect, useRef } from "react";
import { PLUGINS } from "../../plugins/registry";
import { useProjectStore } from "../../core/project_store";

interface ExpandingHeaderProps {
  activePlugin: string;
  onSelect: (id: string) => void;
  config: Record<string, unknown> | null;
  updateBlock: (key: string, payload: Record<string, unknown>) => void;
  onOpenSettings: () => void;
  onOpenDashboard?: () => void;
}

// Hook for auto-calculating optimal icon/text sizes based on screen size and orientation
function useHeaderSizing() {
  const [sizes, setSizes] = useState({
    iconSize: 16,
    textSize: 12,
    showText: true
  });

  useEffect(() => {
    const calculateSizes = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const isVertical = height > width * 1.2;
      
      let iconSize = 16;
      let textSize = 12;
      let showText = true;

      if (isVertical) {
        // Vertical layout - be aggressive about hiding text
        if (width < 500) {
          iconSize = 14;
          textSize = 10;
          showText = false; // No text at all on narrow vertical
        } else if (width < 700) {
          iconSize = 15;
          textSize = 11;
          showText = false; // Still no text, icons only
        } else {
          iconSize = 16;
          textSize = 12;
          showText = true; // Only show text on wider vertical screens
        }
      } else {
        // Horizontal layout - also be aggressive about space
        if (width < 900) {
          iconSize = 15;
          textSize = 11;
          showText = false; // Hide text earlier on horizontal too
        } else if (width < 1100) {
          iconSize = 16;
          textSize = 12;
          showText = true; // Show text at 1100px+
        } else {
          iconSize = 18;
          textSize = 13;
          showText = true; // Full text on wide screens
        }
      }

      setSizes({ iconSize, textSize, showText });
    };

    calculateSizes();
    window.addEventListener('resize', calculateSizes);
    return () => window.removeEventListener('resize', calculateSizes);
  }, []);

  return sizes;
}

function ProjectPill({ onOpenDashboard }: { onOpenDashboard?: () => void }) {
  const { active, defaultProject, projects, fetch, setActive, createProject } = useProjectStore();
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

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1 w-full overflow-hidden rounded-b-xl rounded-r-xl border border-fob-border bg-fob-surface shadow-2xl z-50">
          {creating ? (
            <div className="p-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
                placeholder="Project name..."
                className="w-full px-2 py-1 text-xs bg-fob-bg border border-fob-border rounded text-fob-text"
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setCreating(false); setNewName(""); setOpen(false); }}
                  className="rounded bg-fob-surface-hover text-fob-text px-2 py-1 text-xs font-bold">✕</button>
                <button
                  onClick={() => {
                    if (newName.trim()) {
                      const safe = newName.trim().replace(/[^a-zA-Z0-9\-_ ]/g, "").trim().replace(/ /g, "-") || "untitled";
                      createProject(safe); setCreating(false); setNewName(""); setOpen(false);
                    }
                  }} className="rounded bg-fob-green text-fob-accent-text px-2 py-1 text-xs font-bold">✓</button>
              </div>
            </div>
          ) : (
            <div>
              {projects.map((p) => (
                <button
                  key={p.name}
                  onClick={() => { setActive(p.name); setOpen(false); onOpenDashboard?.(); }}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-xs text-fob-text hover:bg-fob-border transition-colors ${
                    p.name === defaultProject ? "bg-fob-surface-hover" : ""
                  }`}
                >
                  <span>📁</span>
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.name === defaultProject && <span className="text-fob-orange text-[10px]">★</span>}
                  {p.name === active && <span className="text-fob-orange text-[10px]">●</span>}
                </button>
              ))}
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs font-bold text-fob-orange hover:bg-fob-border transition-colors"
              >
                <span>+</span>
                <span>Create New Project</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HeaderClock({ textSize }: { textSize: number }) {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = time.getHours().toString().padStart(2, "0");
  const mm = time.getMinutes().toString().padStart(2, "0");
  const ss = time.getSeconds().toString().padStart(2, "0");
  const isCompact = textSize <= 11;
  
  return (
    <div className="flex items-center font-mono text-fob-text-dim tabular-nums select-none" style={{ fontSize: `${textSize}px`, padding: isCompact ? '0 8px' : '0 12px' }}>
      <span className="text-fob-orange">{hh}</span>
      <span className="text-fob-border mx-0.5">:</span>
      <span>{mm}</span>
      {!isCompact && (
        <>
          <span className="text-fob-border mx-0.5">:</span>
          <span style={{ fontSize: `${textSize - 1}px` }}>{ss}</span>
        </>
      )}
    </div>
  );
}

export function ExpandingHeader({ 
  activePlugin, 
  onSelect, 
  config, 
  updateBlock, 
  onOpenSettings, 
  onOpenDashboard 
}: ExpandingHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedPlugins, setExpandedPlugins] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const { iconSize, textSize, showText } = useHeaderSizing();
  const [showShortcuts, setShowShortcuts] = useState(true);
  const [showClock, setShowClock] = useState(true);

  // Auto-hide shortcuts and clock on smaller screens
  useEffect(() => {
    const width = window.innerWidth;
    if (width < 800) {
      setShowShortcuts(false);
      setShowClock(false);
    } else {
      setShowShortcuts(true);
      setShowClock(true);
    }
  }, [iconSize, textSize]);

  const plugins = (config?.plugins as Record<string, { enabled?: boolean }> | undefined) ?? {};
  const enabledPlugins = PLUGINS.filter((p) => plugins[p.id]?.enabled !== false);
  const hiddenPlugins = PLUGINS.filter((p) => plugins[p.id]?.enabled === false);

  const handleClick = (p: (typeof PLUGINS)[number]) => {
    const isEnabled = plugins[p.id]?.enabled !== false;
    if (!isEnabled) {
      const current = plugins[p.id] ?? {};
      updateBlock("plugins", {
        ...plugins,
        [p.id]: { ...current, enabled: true },
      });
    }
    onSelect(p.id);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setExpanded(false);
        setExpandedPlugins(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Keyboard shortcut to toggle header (Ctrl+Space)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Space to toggle header
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        setExpanded(prev => !prev);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Empty dependency ensures listener only added once

  return (
    <div 
      ref={headerRef}
      className={`fixed top-4 z-50 transition-all duration-300 ease-out ${
        expanded ? 'right-4' : 'right-4'
      }`}
      style={{
        maxWidth: expanded ? '90vw' : 'auto',
      }}
    >
      <div 
        className={`flex items-center bg-fob-bg border border-fob-border shadow-lg overflow-hidden transition-all duration-300 ease-out ${
          expanded ? 'rounded-3xl gap-2 px-2 py-1 flex-row-reverse' : 'rounded-3xl flex-row-reverse'
        }`}
        style={{
          height: 'var(--fob-plugin-bar-height, 48px)',
        }}
      >
        {/* FOB Button - Always Visible */}
        <button
          onClick={() => setExpanded(!expanded)}
          title="Toggle header (Ctrl+Space)"
          className="flex items-center px-3 py-1 font-bold tracking-widest text-fob-accent-text bg-fob-orange hover:bg-fob-orange/90 transition-colors"
          style={{
            fontSize: `${textSize}px`,
            borderRadius: expanded ? '0.75rem' : '0.75rem',
          }}
        >
          <span 
            style={{
              fontSize: `${iconSize}px`,
            }}
          >
            {expanded && showText ? 'ForgeOpenBench' : 'FOB'}
          </span>
        </button>

        {/* Expanded Content */}
        {expanded && (
          <>
            {/* Project Pill */}
            <div className="flex items-center flex-shrink-0 px-2" style={{ minWidth: '200px', maxWidth: '300px' }}>
              <div className="w-full">
                <ProjectPill onOpenDashboard={onOpenDashboard} />
              </div>
            </div>

            {/* Settings gear - between Project and FOB */}
            <button
              onClick={() => onOpenSettings()}
              title="Settings"
              className={`flex items-center px-2 py-1.5 font-mono rounded transition-all flex-shrink-0 ${
                activePlugin === "settings"
                  ? "bg-fob-orange text-fob-accent-text font-semibold shadow-[0_0_8px_rgba(255,153,0,0.4)] border border-fob-orange"
                  : "text-fob-text hover:bg-fob-surface-hover border border-transparent"
              }`}
              style={{
                fontSize: 'var(--fob-plugin-bar-icon-size, 16px)',
              }}
            >
              <span className="leading-none">⚙</span>
            </button>

            {/* Clock - hideable */}
            {showClock && <HeaderClock textSize={textSize} />}

            {/* Plugin Navigation - expandable */}
            <div className="flex items-center gap-1 flex-1 min-w-0">
              {/* Hidden plugins dropdown */}
              {hiddenPlugins.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setExpandedPlugins(!expandedPlugins)}
                    title="Hidden plugins"
                    className="flex items-center gap-1 px-2 py-1.5 font-mono rounded transition-all text-fob-text-dim hover:text-fob-orange hover:bg-fob-surface-hover flex-shrink-0"
                    style={{
                      fontSize: `${textSize}px`,
                    }}
                  >
                    <span 
                      className="leading-none"
                      style={{
                        fontSize: `${iconSize}px`,
                      }}
                    >
                      +
                    </span>
                    {showText && <span className="hidden sm:inline leading-none">More</span>}
                  </button>
                  
                  {expandedPlugins && (
                    <div className="absolute top-full right-0 mt-1 bg-fob-surface border border-fob-border rounded shadow-lg z-50 min-w-[150px]">
                      {hiddenPlugins.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            handleClick(p);
                            setExpandedPlugins(false);
                          }}
                          title={`Enable ${p.name}`}
                          className="flex items-center gap-2 w-full px-3 py-2 font-mono text-left text-fob-text-dim hover:text-fob-text hover:bg-fob-surface-hover"
                          style={{
                            fontSize: 'var(--fob-plugin-bar-text-size, 12px)',
                          }}
                        >
                          <span 
                            style={{
                              fontSize: 'var(--fob-plugin-bar-icon-size, 16px)',
                            }}
                          >
                            {p.icon}
                          </span>
                          <span>{p.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Other enabled plugins in mirrored order (excluding dashboard) */}
              {[...enabledPlugins.filter(p => p.id !== "dashboard")].reverse().map((p) => {
                const isActive = activePlugin === p.id;
                const shortcutNumber = PLUGINS.findIndex(plugin => plugin.id === p.id) + 1;
                return (
                  <button
                    key={p.id}
                    onClick={() => handleClick(p)}
                    title={`${p.name} (Ctrl+${shortcutNumber})`}
                    className={`flex items-center gap-1 px-2 py-1.5 font-mono rounded transition-all flex-shrink-0 relative ${
                      isActive
                        ? "bg-fob-orange text-fob-accent-text font-semibold shadow-[0_0_8px_rgba(255,153,0,0.4)]"
                        : "text-fob-text bg-fob-surface hover:bg-fob-surface-hover"
                    }`}
                    style={{
                      fontSize: `${textSize}px`,
                    }}
                  >
                    <span
                      className="leading-none"
                      style={{
                        fontSize: `${iconSize}px`,
                      }}
                    >
                      {p.icon}
                    </span>
                    {showText && <span className="hidden sm:inline leading-none">{p.name}</span>}
                    {/* Keyboard shortcut indicator - hideable */}
                    {showShortcuts && (
                      <span 
                        className="absolute -top-1 -right-1 text-[8px] font-bold bg-fob-orange text-fob-accent-text rounded-full w-4 h-4 flex items-center justify-center leading-none"
                        style={{
                          fontSize: '8px',
                        }}
                      >
                        {shortcutNumber}
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Home button - positioned at the end for mirrored layout */}
              {(() => {
                const dashboardPlugin = enabledPlugins.find(p => p.id === "dashboard");
                if (!dashboardPlugin) return null;
                
                const isActive = activePlugin === dashboardPlugin.id;
                const shortcutNumber = PLUGINS.findIndex(plugin => plugin.id === dashboardPlugin.id) + 1;
                
                return (
                  <button
                    key={dashboardPlugin.id}
                    onClick={() => handleClick(dashboardPlugin)}
                    title={`${dashboardPlugin.name} (Ctrl+${shortcutNumber})`}
                    className={`flex items-center gap-1 px-2 py-1.5 font-mono rounded transition-all flex-shrink-0 relative ${
                      isActive
                        ? "bg-fob-orange text-fob-accent-text font-semibold shadow-[0_0_8px_rgba(255,153,0,0.4)]"
                        : "text-fob-text bg-fob-surface hover:bg-fob-surface-hover"
                    }`}
                    style={{
                      fontSize: `${textSize}px`,
                    }}
                  >
                    <span
                      className="leading-none"
                      style={{
                        fontSize: `${iconSize}px`,
                      }}
                    >
                      {dashboardPlugin.icon}
                    </span>
                    {showText && <span className="hidden sm:inline leading-none">{dashboardPlugin.name}</span>}
                    {/* Keyboard shortcut indicator - hideable */}
                    {showShortcuts && (
                      <span
                        className="absolute -top-1 -right-1 text-[8px] font-bold bg-fob-orange text-fob-accent-text rounded-full w-4 h-4 flex items-center justify-center leading-none"
                        style={{
                          fontSize: '8px',
                        }}
                      >
                        {shortcutNumber}
                      </span>
                    )}
                  </button>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
