import { PluginErrorBoundary } from "../../shared/components/PluginErrorBoundary";
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState, useCallback } from "react";
import type { PluginLifecycle, PluginBus } from "../types";
import { useProjectStore, type ProjectMeta } from "../../core/project_store";
import { globalBus } from "../../core/global_bus";

interface TemplateMeta { id: string; label: string; description: string; builtin: boolean; }

async function fetchTemplates(): Promise<TemplateMeta[]> {
  try {
    const res = await fetch("/api/v1/workspace/templates");
    if (res.ok) return (await res.json()).templates;
  } catch { /* offline */ }
  return [
    { id: "blank", label: "Blank", description: "Empty project with standard folders.", builtin: true },
    { id: "teardown", label: "Teardown", description: "IC teardown / reverse-engineering.", builtin: true },
    { id: "firmware-debug", label: "Firmware Debug", description: "UART/JTAG debug session.", builtin: true },
    { id: "signal-capture", label: "Signal Capture", description: "LA / DSO capture session.", builtin: true },
  ];
}

// ── Subfolder card ─────────────────────────────────────────────────────────────
const SUBDIR_META: Record<string, { icon: string; label: string; color: string }> = {
  captures: { icon: "📷", label: "Captures",  color: "text-fob-orange" },
  notes:    { icon: "📝", label: "Notes",     color: "text-fob-orange"   },
  waveforms:{ icon: "〰️", label: "Waveforms", color: "text-fob-orange" },
  firmware: { icon: "💾", label: "Firmware",  color: "text-fob-orange"  },
  scripts:  { icon: "🖥️",  label: "Scripts",  color: "text-fob-orange" },
};

function SubdirCard({ dir, count, onNav }: { dir: string; count: number; onNav: () => void }) {
  const meta = SUBDIR_META[dir] ?? { icon: "📁", label: dir, color: "text-fob-text-dim" };
  return (
    <button onClick={onNav}
      className="flex flex-col items-center gap-2 rounded-xl border border-fob-border bg-fob-surface p-4 hover:border-fob-orange hover:bg-fob-bg transition-all group">
      <span className="text-3xl">{meta.icon}</span>
      <span className={`text-xs font-bold font-mono ${meta.color}`}>{meta.label}</span>
      <span className="text-[10px] text-fob-text-dim">{count} file{count !== 1 ? "s" : ""}</span>
    </button>
  );
}

// ── Project card in the project list ──────────────────────────────────────────
function ProjectCard({ project, isActive, onSelect, onExport }: { project: ProjectMeta; isActive: boolean; onSelect: () => void; onExport: () => void }) {
  const age = Math.floor((Date.now() / 1000 - project.updated_at) / 86400);
  const ageStr = age === 0 ? "today" : age === 1 ? "yesterday" : `${age}d ago`;
  return (
    <div className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 transition-all ${
      isActive
        ? "border-fob-orange bg-fob-orange/10 shadow-[0_0_12px_rgba(255,153,0,0.15)]"
        : "border-fob-border bg-fob-surface hover:border-fob-orange/50 hover:bg-fob-bg"
    }`}>
      <button onClick={onSelect} className="flex flex-1 items-center gap-3 text-left min-w-0">
        <span className="text-2xl flex-shrink-0">{isActive ? "📂" : "📁"}</span>
        <div className="flex-1 min-w-0">
          <div className={`font-mono font-bold text-sm truncate ${isActive ? "text-fob-orange" : "text-fob-text"}`}>
            {project.name}
          </div>
          <div className="text-[10px] text-fob-text-dim font-mono">
            {project.notes} notes · {project.captures} captures · {ageStr}
          </div>
        </div>
        {isActive && <span className="text-[9px] font-bold text-fob-orange bg-fob-orange/20 rounded-full px-2 py-0.5 flex-shrink-0">ACTIVE</span>}
      </button>
      <button onClick={(e) => { e.stopPropagation(); onExport(); }}
        title="Export project as .zip"
        className="flex-shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-mono text-fob-text-dim hover:text-fob-orange hover:bg-fob-border transition-colors">
        ⬇ .zip
      </button>
    </div>
  );
}

// ── New project form ───────────────────────────────────────────────────────────
function NewProjectForm({ onCreate }: { onCreate: (name: string, template: string) => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  const [templates, setTemplates] = useState<TemplateMeta[]>([
    { id: "blank", label: "Blank", description: "Empty project with standard folders.", builtin: true },
  ]);
  useEffect(() => { void fetchTemplates().then(setTemplates); }, []);
  const submit = () => { if (name.trim()) { onCreate(name.trim(), template); setName(""); } };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="project-name"
          className="flex-1 rounded-lg bg-fob-bg border border-fob-border px-3 py-2 text-sm font-mono text-fob-text outline-none focus:border-fob-orange" />
        <button onClick={submit}
          className="rounded-lg bg-fob-green text-fob-accent-text px-4 py-2 text-sm font-bold hover:opacity-90">
          Create
        </button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {templates.map((t) => (
          <button key={t.id} onClick={() => setTemplate(t.id)}
            title={t.description}
            className={`rounded-lg px-3 py-1.5 text-xs font-mono font-bold border transition-colors ${
              template === t.id
                ? "bg-fob-orange text-fob-accent-text border-fob-orange"
                : "bg-fob-bg border-fob-border text-fob-text-dim hover:border-fob-orange hover:text-fob-text"
            }`}>
            {t.label}
          </button>
        ))}
      </div>
      {template !== "blank" && (
        <p className="text-[10px] font-mono text-fob-text-dim">
          {templates.find((t) => t.id === template)?.description}
        </p>
      )}
    </div>
  );
}

// ── Subfolder file list (fetched from API) ─────────────────────────────────────
interface SubdirCounts { captures: number; notes: number; waveforms: number; firmware: number; scripts: number; }

async function fetchSubdirCounts(projectName: string): Promise<SubdirCounts> {
  try {
    const res = await fetch(`/api/v1/workspace/projects/${encodeURIComponent(projectName)}/counts`);
    if (res.ok) return await res.json();
  } catch { /* offline */ }
  return { captures: 0, notes: 0, waveforms: 0, firmware: 0, scripts: 0 };
}

// ── Main dashboard ─────────────────────────────────────────────────────────────
function DashboardApp({ onNavigate }: { onNavigate: (plugin: string) => void }) {
  const { active, projects, fetch, setActive, createProject, exportProject } = useProjectStore();
  const [counts, setCounts] = useState<SubdirCounts>({ captures: 0, notes: 0, waveforms: 0, firmware: 0, scripts: 0 });
  const [creating, setCreating] = useState(false);

  useEffect(() => { fetch(); }, [fetch]);

  const refreshCounts = useCallback(() => {
    if (active) fetchSubdirCounts(active).then(setCounts);
  }, [active]);

  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  // Re-fetch counts whenever lens or note saves happen
  useEffect(() => {
    const unsub1 = globalBus.on("noteforge.refresh", refreshCounts);
    const unsub2 = globalBus.on("workspace.counts.refresh", refreshCounts);
    return () => { unsub1(); unsub2(); };
  }, [refreshCounts]);

  const handleCreate = useCallback(async (name: string, template: string) => {
    await createProject(name, template);
    setCreating(false);
  }, [createProject]);

  const activeProject = projects.find((p) => p.name === active);

  return (
    <div className="flex h-full w-full bg-fob-bg text-fob-text overflow-auto">
      <div className="flex flex-col gap-6 p-6 w-full max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-mono text-fob-orange">Forge Open Bench</h1>
            <p className="text-xs text-fob-text-dim font-mono mt-0.5">Hardware RE · Debug · Capture · Document</p>
          </div>
          <button onClick={() => setCreating((v) => !v)}
            className="rounded-xl bg-fob-orange text-fob-accent-text px-4 py-2 text-sm font-bold hover:opacity-90 transition-opacity">
            + New Project
          </button>
        </div>

        {creating && (
          <div className="rounded-xl border border-fob-orange/50 bg-fob-surface p-4">
            <p className="text-xs font-mono text-fob-text-dim mb-2">Project name (alphanumeric, dashes):</p>
            <NewProjectForm onCreate={handleCreate} />
          </div>
        )}

        {/* Active project workspace */}
        {active && (
          <div className="rounded-xl border border-fob-border bg-fob-surface p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-fob-orange font-mono font-bold text-sm uppercase tracking-wider">Active Project</span>
              <span className="text-lg">📂</span>
              <span className="font-mono font-bold text-fob-text">{active}</span>
            </div>
            <div className="grid grid-cols-5 gap-3">
              {(Object.keys(SUBDIR_META) as (keyof SubdirCounts)[]).map((dir) => (
                <SubdirCard key={dir} dir={dir} count={counts[dir] ?? 0}
                  onNav={() => {
                    if (dir === "notes") onNavigate("noteforge");
                    else if (dir === "captures") onNavigate("lensforge");
                  }} />
              ))}
            </div>
            {activeProject?.has_readme && (
              <button onClick={() => onNavigate("noteforge")}
                className="flex items-center gap-2 rounded-lg border border-fob-border bg-fob-bg px-3 py-2 text-left text-xs hover:border-fob-orange transition-colors">
                <span>📄</span>
                <span className="font-mono font-bold text-fob-text">README.md</span>
                <span className="text-fob-text-dim ml-auto">Open in NoteForge →</span>
              </button>
            )}
          </div>
        )}

        {/* All projects */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold font-mono uppercase tracking-wider text-fob-text-dim">All Projects</span>
            <span className="text-[10px] text-fob-text-dim">{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
          </div>
          {projects.length === 0 ? (
            <div className="rounded-xl border border-fob-border bg-fob-surface p-6 text-center text-xs text-fob-text-dim font-mono">
              No projects yet. Create one above.
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[216px] overflow-y-auto pr-1">
              {projects.map((p) => (
                <ProjectCard key={p.name} project={p} isActive={p.name === active}
                  onSelect={() => setActive(p.name)}
                  onExport={() => exportProject(p.name)} />
              ))}
            </div>
          )}
        </div>

        {/* Quick nav */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { id: "lensforge",    icon: "🔬", label: "Open LensForge",    desc: "Camera · Capture · Annotate" },
            { id: "noteforge",    icon: "📝", label: "Open NoteForge",    desc: "Notes · Markdown · Review"   },
            { id: "waveforge",    icon: "📊", label: "Open WaveForge",    desc: "DSO · Logic Analyzer"        },
            { id: "pocketforge",  icon: "⚡", label: "Open PocketForge",  desc: "Multimeter · BLE"            },
            { id: "monitorforge", icon: "⎆", label: "Open MonitorForge", desc: "Serial · UART · Monitor"     },
          ].map(({ id, icon, label, desc }) => (
            <button key={id} onClick={() => onNavigate(id)}
              className="flex items-center gap-3 rounded-xl border border-fob-border bg-fob-surface px-4 py-3 text-left hover:border-fob-orange hover:bg-fob-bg transition-all">
              <span className="text-2xl">{icon}</span>
              <div>
                <div className="text-sm font-bold text-fob-text">{label}</div>
                <div className="text-[10px] text-fob-text-dim font-mono">{desc}</div>
              </div>
              <span className="ml-auto text-fob-text-dim">→</span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}

// ── Plugin lifecycle ───────────────────────────────────────────────────────────
class DashboardPlugin implements PluginLifecycle {
  private root?: Root;
  private onNavigate?: (plugin: string) => void;

  mount(container: HTMLElement, bus: PluginBus): void {
    this.onNavigate = (plugin: string) => bus.emit("app.navigate", { plugin });
    this.root = createRoot(container);
    this.root.render(<PluginErrorBoundary pluginId="dashboard"><DashboardApp onNavigate={this.onNavigate} /></PluginErrorBoundary>);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = undefined;
  }
}

export default DashboardPlugin;
