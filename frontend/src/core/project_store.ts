import { create } from "zustand";
import { globalBus } from "./global_bus";

export interface ProjectMeta {
  name: string;
  notes: number;
  captures: number;
  has_readme: boolean;
  updated_at: number;
}

interface ProjectStore {
  active: string | null;
  defaultProject: string | null;
  projects: ProjectMeta[];
  loading: boolean;
  fetch: () => Promise<void>;
  setActive: (name: string) => Promise<void>;
  setDefault: (name: string) => Promise<void>;
  createProject: (name: string, template?: string) => Promise<void>;
  exportProject: (name: string) => void;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  active: null,
  defaultProject: null,
  projects: [],
  loading: false,

  fetch: async () => {
    set({ loading: true });
    try {
      const res = await fetch("/api/v1/workspace/projects");
      if (res.ok) {
        const data = await res.json();
        set({
          projects: data.projects,
          active: data.active ?? data.projects[0]?.name ?? null,
          defaultProject: data.default_project ?? null,
        });
      }
    } catch { /* server offline */ }
    finally { set({ loading: false }); }
  },

  setActive: async (name: string) => {
    try {
      const res = await fetch("/api/v1/workspace/active", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: name }),
      });
      if (res.ok) {
        set({ active: name });
        globalBus.emit("workspace.project.changed", { project: name });
      }
    } catch { /* offline */ }
  },

  setDefault: async (name: string) => {
    try {
      const res = await fetch("/api/v1/workspace/default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: name }),
      });
      if (res.ok) set({ defaultProject: name });
    } catch { /* offline */ }
  },

  createProject: async (name: string, template = "blank") => {
    try {
      const res = await fetch(`/api/v1/workspace/projects/${encodeURIComponent(name)}?template=${encodeURIComponent(template)}`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as { name?: string };
        const safeName = data.name || name;
        await get().fetch();
        await get().setActive(safeName);
      }
    } catch { /* offline */ }
  },

  exportProject: (name: string) => {
    const url = `/api/v1/workspace/projects/${encodeURIComponent(name)}/export`;
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.zip`; a.click();
  },
}));

// Refresh project list whenever saves happen (note or capture)
globalBus.on("workspace.counts.refresh", () => {
  void useProjectStore.getState().fetch();
});
