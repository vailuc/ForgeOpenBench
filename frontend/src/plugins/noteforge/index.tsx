import { PluginErrorBoundary } from "../../shared/components/PluginErrorBoundary";
import type { PluginLifecycle, PluginBus } from "../types";
import { createRoot, type Root } from "react-dom/client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { parseNoteCells, patchLayersInMarkdown } from "./noteCells";
import { NoteCellRenderer } from "./NoteCellRenderer";
import { globalBus } from "../../core/global_bus";
import { toast } from "../../shared/hooks/useToastStore";
import { useProjectStore } from "../../core/project_store";
import { useSettingsStore } from "../../core/settings_store";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  ext?: string;
  size?: number;
  children?: TreeNode[];
}

const API = "/api/v1";
const EMPTY_CFG: Record<string, unknown> = {};

interface NoteMeta {
  name: string;
  updated_at: number;
  title?: string;
}

type ViewMode = "edit" | "preview" | "split";

const TAG_RE = /#[a-zA-Z][a-zA-Z0-9_-]*/g;

function extractTags(text: string): string[] {
  const found = text.match(TAG_RE);
  if (!found) return [];
  // Deduplicate while preserving first-seen order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of found) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function extractTitle(content: string): string {
  const firstH1 = content.match(/^#\s+(.+)$/m);
  if (firstH1) return firstH1[1].trim();
  const firstLine = content.split("\n").find((l) => l.trim());
  if (firstLine) return firstLine.trim().slice(0, 40);
  return "Untitled";
}

function NoteForgeApp(_: { bus: PluginBus }) {
  const projectName = useProjectStore((s) => s.active);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [activeNoteIsProjectFile, setActiveNoteIsProjectFile] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>("");
  const [newFolderInput, setNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [projectTree, setProjectTree] = useState<TreeNode[]>([]);
  const [projectTreeOpen, setProjectTreeOpen] = useState(true);
  const [openProjectDirs, setOpenProjectDirs] = useState<Set<string>>(new Set());
  const handleWikiLink = useCallback((title: string) => {
    const lc = title.toLowerCase();
    const match = notes.find(
      (n) => n.title?.toLowerCase() === lc || n.name.toLowerCase() === lc
    );
    if (match) {
      setActiveNote(match.name);
    } else {
      toast.info(`No note titled "${title}"`);
    }
  }, [notes]);

  const handleTagClick = useCallback((tag: string) => {
    setActiveTag(tag);
  }, []);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContent = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Undo/redo history ring (50 entries)
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const historySkipRef = useRef(false); // prevent push during undo/redo restore
  const blobMapRef = useRef<Map<string, string>>(new Map());
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{name:string;folder:string;snippet:string}[]|null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(13);
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  const config = useSettingsStore((s) => s.config);
  const noteforgeConfig = (config?.noteforge as Record<string, unknown> | undefined) ?? EMPTY_CFG;
  const updateNoteforge = useSettingsStore((s) => s.updateBlock);

  useEffect(() => {
    const cfgFontSize = Number(noteforgeConfig.fontSize ?? 14);
    if (cfgFontSize >= 10 && cfgFontSize <= 20) setFontSize(cfgFontSize);
    const cfgViewMode = noteforgeConfig.defaultViewMode as ViewMode | undefined;
    if (cfgViewMode && ["edit", "preview", "split"].includes(cfgViewMode)) setViewMode(cfgViewMode);
  }, [noteforgeConfig.fontSize, noteforgeConfig.defaultViewMode]);

  const setFontSizeAndConfig = useCallback((next: number) => {
    const clamped = Math.max(10, Math.min(20, next));
    setFontSize(clamped);
    updateNoteforge("noteforge", { ...noteforgeConfig, fontSize: clamped });
  }, [noteforgeConfig, updateNoteforge]);

  const setViewModeAndConfig = useCallback((next: ViewMode) => {
    setViewMode(next);
    updateNoteforge("noteforge", { ...noteforgeConfig, defaultViewMode: next });
  }, [noteforgeConfig, updateNoteforge]);

  const autoSave = noteforgeConfig.autoSave !== false;

  const allTags = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of notes) {
      const text = `${n.title ?? ""} ${n.name ?? ""}`;
      for (const tag of extractTags(text)) {
        if (!seen.has(tag)) {
          seen.add(tag);
          out.push(tag);
        }
      }
    }
    return out;
  }, [notes]);
  const LOCAL_NOTES_KEY = "fob_notes_list";

  useEffect(() => {
    if (!search.trim()) { setSearchResults(null); return; }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/notes/search?q=${encodeURIComponent(search.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.results);
        }
      } catch { setSearchResults([]); }
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const loadFolders = useCallback(async () => {
    try {
      const res = await fetch(`${API}/notes/folders`);
      if (res.ok) {
        const data = await res.json();
        setFolders(data.folders as string[]);
      }
    } catch { /* server down — no folders */ }
  }, []);

  const createFolder = useCallback(async (name: string) => {
    const safe = name.trim();
    if (!safe) return;
    try {
      await fetch(`${API}/notes/folders/${encodeURIComponent(safe)}`, { method: "POST" });
    } catch { /* offline — folder will be created on next save attempt */ }
    await loadFolders();
    setActiveFolder(safe);
    setNewFolderInput(false);
    setNewFolderName("");
  }, [loadFolders]);

  // Load note list — server first, localStorage fallback (scans all fob_note_* keys)
  const refreshList = useCallback(async () => {
    try {
      const res = await fetch(`${API}/notes`);
      if (res.ok) {
        const list = (await res.json()) as NoteMeta[];
        const enriched = list.map((n) => {
          const cached = localStorage.getItem(`fob_note_${n.name}`);
          if (cached) { try { return { ...n, title: extractTitle(JSON.parse(cached).content || "") }; } catch { /* skip */ } }
          return n;
        });
        setNotes(enriched);
        return;
      }
    } catch {
      // network/server down — fall through to localStorage scan
    }
    // Fallback: scan all fob_note_* keys in localStorage
    try {
      const list: NoteMeta[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("fob_note_") && key !== LOCAL_NOTES_KEY) {
          const raw = localStorage.getItem(key);
          if (raw) {
            const data = JSON.parse(raw);
            list.push({ name: data.name, updated_at: data.updated_at || 0, title: extractTitle(data.content || "") });
          }
        }
      }
      list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
      setNotes(list);
    } catch {
      setNotes([]);
    }
  }, []);

  // Load project tree for the sidebar
  const loadProjectTree = useCallback(async () => {
    if (!projectName) { setProjectTree([]); return; }
    try {
      const res = await fetch(`${API}/workspace/projects/${encodeURIComponent(projectName)}/tree`);
      if (res.ok) {
        const data = await res.json();
        setProjectTree(data.tree ?? []);
      } else {
        setProjectTree([]);
      }
    } catch { setProjectTree([]); }
  }, [projectName]);

  useEffect(() => {
    loadProjectTree();
  }, [loadProjectTree, projectName]);

  useEffect(() => {
    return globalBus.on("workspace.project.changed", () => {
      setActiveNote(null);
      setActiveNoteIsProjectFile(false);
      setReadOnly(false);
      setContent("");
      lastSavedContent.current = "";
      void loadProjectTree();
    });
  }, [loadProjectTree]);

  // Initial load
  useEffect(() => {
    refreshList().finally(() => setLoaded(true));
    void loadFolders();
  }, [refreshList, loadFolders]);

  // Load a note — server first, localStorage fallback
  const loadNote = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${API}/notes/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        setActiveNote(data.name);
        setActiveNoteIsProjectFile(false);
        setReadOnly(false);
        setContent(data.content);
        lastSavedContent.current = data.content;
        historyRef.current = [data.content];
        historyIdxRef.current = 0;
        setDirty(false);
        return;
      }
    } catch {
      // server down — fall through to localStorage
    }
    // Fallback: read from localStorage
    try {
      const raw = localStorage.getItem(`fob_note_${name}`);
      if (raw) {
        const data = JSON.parse(raw);
        setActiveNote(data.name);
        setActiveNoteIsProjectFile(false);
        setReadOnly(false);
        setContent(data.content);
        lastSavedContent.current = data.content;
        historyRef.current = [data.content];
        historyIdxRef.current = 0;
        setDirty(false);
      }
    } catch { /* ignore */ }
  }, []);

  // Save a project file (README.md, etc.)
  const saveProjectFile = useCallback(async () => {
    if (!projectName || !activeNote || !activeNoteIsProjectFile || readOnly || content === lastSavedContent.current) return;
    try {
      await fetch(`${API}/workspace/projects/${encodeURIComponent(projectName)}/file?path=${encodeURIComponent(activeNote)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    } catch { /* offline — no localStorage fallback for project files yet */ }
    lastSavedContent.current = content;
    setDirty(false);
    void loadProjectTree();
  }, [projectName, activeNote, activeNoteIsProjectFile, readOnly, content, loadProjectTree]);

  // Save current note — server first, localStorage fallback
  const doSave = useCallback(async () => {
    if (!activeNote || content === lastSavedContent.current) return;
    if (activeNoteIsProjectFile) { await saveProjectFile(); return; }
    try {
      await fetch(`${API}/notes/${encodeURIComponent(activeNote)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, folder: activeFolder || undefined }),
      });
    } catch {
      // server down — save to localStorage only
    }
    // Always persist locally so offline mode works
    localStorage.setItem(`fob_note_${activeNote}`, JSON.stringify({ name: activeNote, content, updated_at: Date.now() / 1000 }));
    lastSavedContent.current = content;
    setDirty(false);
    setNotes((prev) => prev.map((n) => n.name === activeNote ? { ...n, title: extractTitle(content) } : n));
    refreshList();
    globalBus.emit("workspace.counts.refresh");
  }, [activeNote, content, activeNoteIsProjectFile, saveProjectFile, activeFolder, refreshList]);

  // Debounced save (only when autoSave is enabled)
  const scheduleSave = useCallback(() => {
    if (!autoSave) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => doSave(), 500);
  }, [doSave, autoSave]);

  // Flush on unmount / note switch
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirty && activeNote) doSave();
  }, [dirty, activeNote, doSave]);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      flushSave();
    };
  }, [flushSave]);

  // Load a project file (README.md, text files, or binary assets as read-only refs)
  const loadProjectFile = useCallback(async (relativePath: string) => {
    if (!projectName) return;
    flushSave();
    const ext = (relativePath.split(".").pop() ?? "").toLowerCase();
    const isBinary = [
      "bin", "hex", "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "psd", "ai", "eps",
      "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
      "so", "o", "elf", "dll", "dylib", "exe", "app", "deb", "rpm", "apk", "ipa", "dmg",
      "ttf", "otf", "woff", "woff2", "eot",
      "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
      "mp4", "webm", "mov", "avi", "mkv",
      "wav", "mp3", "flac", "ogg", "aac", "m4a", "wma",
    ].includes(ext);
    if (isBinary) {
      const filename = relativePath.split("/").pop() ?? relativePath;
      const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico"].includes(ext);
      const ref = isImage ? `![${filename}](${relativePath})` : `[${filename}](${relativePath})`;
      setActiveNote(relativePath);
      setActiveNoteIsProjectFile(true);
      setReadOnly(true);
      setContent(ref);
      lastSavedContent.current = ref;
      historyRef.current = [ref];
      historyIdxRef.current = 0;
      setDirty(false);
      setExpandedLines(new Set());
      return;
    }
    try {
      const res = await fetch(`${API}/workspace/projects/${encodeURIComponent(projectName)}/file?path=${encodeURIComponent(relativePath)}`);
      if (res.ok) {
        const data = await res.json();
        setActiveNote(relativePath);
        setActiveNoteIsProjectFile(true);
        setReadOnly(false);
        setContent(data.content || "");
        lastSavedContent.current = data.content || "";
        historyRef.current = [data.content || ""];
        historyIdxRef.current = 0;
        setDirty(false);
        setExpandedLines(new Set());
      }
    } catch { /* offline — ignore */ }
  }, [projectName, flushSave]);

  const handleContentChange = useCallback((value: string) => {
    if (!historySkipRef.current) {
      const hist = historyRef.current;
      // Truncate forward history on new edit
      hist.splice(historyIdxRef.current + 1);
      hist.push(value);
      if (hist.length > 50) hist.shift();
      historyIdxRef.current = hist.length - 1;
    }
    setContent(value);
    setDirty(true);
    scheduleSave();
  }, [scheduleSave]);

  // ── Layer edit write-back from preview/split sidebar ──
  const handleUpdateLayers = useCallback((imageDataUrl: string, layers: import("../lensforge/types").AnnotationLayer[]) => {
    const next = patchLayersInMarkdown(content, imageDataUrl, layers);
    if (next !== content) {
      handleContentChange(next);
      if (autoSave) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => doSave(), 500);
      }
    }
  }, [content, handleContentChange, doSave, autoSave]);

  const handleNewNote = useCallback(async () => {
    flushSave();
    setReadOnly(false);
    const name = `note-${Date.now()}`;
    const initialContent = "# New Note\n\n";
    try {
      await fetch(`${API}/notes/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: initialContent }),
      });
    } catch {
      // server down — create locally only
    }
    localStorage.setItem(`fob_note_${name}`, JSON.stringify({ name, content: initialContent, updated_at: Date.now() / 1000 }));
    await refreshList();
    await loadNote(name);
  }, [flushSave, refreshList, loadNote]);

  // Insert a markdown reference to a project file at the cursor
  const insertFileReference = useCallback((node: TreeNode) => {
    const rel = node.path.replace(`${projectName}/`, "");
    let insertion = "";
    const ext = (node.ext ?? "").toLowerCase();
    if (ext === ".md") {
      insertion = `[[${node.name}]]`;
    } else if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
      insertion = `![${node.name}](${rel})`;
    } else {
      const details = `<details><summary>${node.name}</summary>\n\n- Path: \`${rel}\`\n- Size: ${(node.size ?? 0).toLocaleString()} bytes\n- Type: ${ext || "file"}\n\n</details>`;
      insertion = `[${node.name}](${rel})\n\n${details}`;
    }
    const ta = textareaRef.current;
    if (ta && activeNote) {
      const start = ta.selectionStart ?? content.length;
      const end = ta.selectionEnd ?? content.length;
      const prefix = content.slice(0, start);
      const suffix = content.slice(end);
      const sep = prefix.endsWith("\n\n") ? "" : "\n\n";
      const next = prefix + sep + insertion + "\n\n" + suffix;
      handleContentChange(next);
      requestAnimationFrame(() => {
        const pos = start + sep.length + insertion.length + 2;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
    } else if (activeNote) {
      const sep = content.endsWith("\n\n") ? "" : "\n\n";
      handleContentChange(content + sep + insertion + "\n\n");
    } else {
      toast.info("Open a note first");
    }
  }, [projectName, content, activeNote, handleContentChange]);

  // Auto-open project README when NoteForge mounts or project changes; create it if missing
  useEffect(() => {
    if (!projectName || activeNote) return;
    const readme = projectTree.find((n) => n.name === "README.md" && n.type === "file");
    if (readme) {
      void loadProjectFile("README.md");
    } else {
      const template = `# ${projectName}\n\nProject notebook for ${projectName}.\n`;
      void fetch(`${API}/workspace/projects/${encodeURIComponent(projectName)}/file?path=README.md`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: template }),
      }).then(async (res) => {
        if (res.ok) { await loadProjectTree(); void loadProjectFile("README.md"); }
      });
    }
  }, [projectName, projectTree, activeNote, loadProjectFile, loadProjectTree]);

  // W2 — receive WaveForge canvas snapshots
  useEffect(() => {
    return globalBus.on("noteforge.insert.image", (payload) => {
      const { dataUrl, caption } = payload as { dataUrl: string; caption: string };
      const insert = () => {
        setContent(prev => prev + `\n\n![${caption}](${dataUrl})\n`);
        setDirty(true);
        scheduleSave();
        toast.success("Snapshot saved to note");
      };
      if (!activeNote) {
        void handleNewNote().then(insert);
        return;
      }
      insert();
    });
  }, [activeNote, handleNewNote, scheduleSave]);

  // ── GlobalBus: noteforge.refresh — refresh note list (triggered after external saves) ──
  useEffect(() => {
    return globalBus.on("noteforge.refresh", () => { void refreshList(); });
  }, [refreshList]);

  // ── GlobalBus: noteforge.open — navigate to a specific note by name ──
  useEffect(() => {
    return globalBus.on("noteforge.open", (payload) => {
      const { name } = payload as { name: string };
      if (!name) return;
      void refreshList().then(() => loadNote(name));
    });
  }, [refreshList, loadNote]);

  // ── GlobalBus: noteforge.insert — insert markdown at cursor (from LensForge etc.) ──
  useEffect(() => {
    return globalBus.on("noteforge.insert", (payload) => {
      const { markdown } = payload as { markdown: string };
      if (!markdown) return;
      if (!activeNote) {
        void handleNewNote().then(() => {
          setContent((prev) => prev + "\n\n" + markdown);
          setDirty(true);
          scheduleSave();
        });
        return;
      }
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart ?? content.length;
        const end = ta.selectionEnd ?? content.length;
        const prefix = content.slice(0, start);
        const suffix = content.slice(end);
        const insertion = (prefix.endsWith("\n\n") ? "" : "\n\n") + markdown + "\n\n";
        const next = prefix + insertion + suffix;
        handleContentChange(next);
        requestAnimationFrame(() => {
          const pos = start + insertion.length;
          ta.setSelectionRange(pos, pos);
          ta.focus();
        });
      } else {
        setContent((prev) => {
          const sep = prev.endsWith("\n\n") ? "" : "\n\n";
          return prev + sep + markdown + "\n\n";
        });
        setDirty(true);
        scheduleSave();
      }
    });
  }, [activeNote, content, handleContentChange, handleNewNote, scheduleSave]);

  // ── Base64 collapse helpers ───────────────────────────────────────────────
  const BASE64_LINE_RE = /^(!\[.*?\]\(data:image\/[^)]{40,}\))$/;
  const PLACEHOLDER_PREFIX = "![\U0001f4f7 image hidden — click to reveal](";

  const toDisplay = useCallback((raw: string, expanded: Set<number>): string => {
    const map = new Map<string, string>();
    const lines = raw.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Collapse base64 image lines
      if (BASE64_LINE_RE.test(line) && !expanded.has(i)) {
        const placeholder = `${PLACEHOLDER_PREFIX}${i})`;
        map.set(placeholder, line);
        out.push(placeholder);
        i++;
        continue;
      }
      // Collapse <details> blocks
      if (line.trimStart().startsWith("<details") && !expanded.has(i)) {
        const startIdx = i;
        const detailLines: string[] = [line];
        i++;
        while (i < lines.length && !lines[i].includes("</details>")) {
          detailLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) { detailLines.push(lines[i]); i++; }
        const summaryMatch = detailLines.join("\n").match(/<summary>(.*?)<\/summary>/);
        const label = summaryMatch ? summaryMatch[1] : "details";
        const placeholder = `<details-hidden idx="${startIdx}">▶ ${label} (click to expand)</details-hidden>`;
        map.set(placeholder, detailLines.join("\n"));
        out.push(placeholder);
        continue;
      }
      out.push(line);
      i++;
    }
    blobMapRef.current = map;
    return out.join("\n");
  }, []);

  const fromDisplay = useCallback((display: string): string => {
    return display.split("\n").map((line) => {
      return blobMapRef.current.get(line) ?? line;
    }).join("\n");
  }, []);

  const handleTextareaClick = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const lineIdx = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    const line = ta.value.split("\n")[lineIdx] ?? "";
    const isBase64Placeholder = line.startsWith(PLACEHOLDER_PREFIX);
    const detailsMatch = line.match(/<details-hidden idx="(\d+)">/);
    if (isBase64Placeholder) {
      setExpandedLines((prev) => { const next = new Set(prev); next.add(lineIdx); return next; });
    } else if (detailsMatch) {
      const origIdx = parseInt(detailsMatch[1], 10);
      setExpandedLines((prev) => { const next = new Set(prev); next.add(origIdx); return next; });
    }
  }, []);

  // Reset expanded lines when switching notes
  useEffect(() => { setExpandedLines(new Set()); }, [activeNote]);

  const handleSelectNote = (name: string) => {
    if (name === activeNote) return;
    flushSave();
    loadNote(name);
  };

  const handleDeleteNote = async (name: string) => {
    if (!window.confirm(`Delete "${name}"?`)) return;
    flushSave();
    // Remove from server
    try {
      await fetch(`${API}/notes/${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch {
      // server down — handled locally below
    }
    // Remove from localStorage
    localStorage.removeItem(`fob_note_${name}`);
    setNotes((prev) => prev.filter((n) => n.name !== name));
    if (activeNote === name) {
      setActiveNote(null);
      setContent("");
      lastSavedContent.current = "";
      setDirty(false);
    }
  };

  const startRename = async (name: string) => {
    let noteContent = "";
    try {
      const res = await fetch(`${API}/notes/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        noteContent = data.content;
      }
    } catch {
      // server down — read from localStorage
      const raw = localStorage.getItem(`fob_note_${name}`);
      if (raw) {
        const data = JSON.parse(raw);
        noteContent = data.content;
      }
    }
    if (!noteContent) return;
    setEditingName(name);
    setRenameValue(extractTitle(noteContent));
  };

  const commitRename = async (oldName: string) => {
    const newName = renameValue.trim() || oldName;
    if (newName === oldName) {
      setEditingName(null);
      return;
    }
    let oldContent = "";
    // Read old content
    try {
      const oldRes = await fetch(`${API}/notes/${encodeURIComponent(oldName)}`);
      if (oldRes.ok) {
        const data = await oldRes.json();
        oldContent = data.content;
      }
    } catch {
      const raw = localStorage.getItem(`fob_note_${oldName}`);
      if (raw) oldContent = JSON.parse(raw).content;
    }
    if (!oldContent) { setEditingName(null); return; }
    // Update first H1 to new title if present
    const updatedContent = oldContent.match(/^#\s+/m)
      ? oldContent.replace(/^#\s+.+$/m, `# ${newName}`)
      : `# ${newName}\n\n${oldContent}`;
    try {
      await fetch(`${API}/notes/${encodeURIComponent(newName)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: updatedContent }),
      });
      await fetch(`${API}/notes/${encodeURIComponent(oldName)}`, { method: "DELETE" });
    } catch {
      // server down — handle purely locally
    }
    // Local mirror regardless of server
    localStorage.setItem(`fob_note_${newName}`, JSON.stringify({ name: newName, content: updatedContent, updated_at: Date.now() / 1000 }));
    localStorage.removeItem(`fob_note_${oldName}`);
    setEditingName(null);
    await refreshList();
    if (activeNote === oldName) {
      setActiveNote(newName);
      setContent(updatedContent);
      lastSavedContent.current = updatedContent;
    }
  };

  const toggleProjectDir = (path: string) => {
    setOpenProjectDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderTreeNode = (node: TreeNode, depth: number) => {
    const padding = `pl-${3 + depth * 2}`;
    if (node.type === "dir") {
      const open = !openProjectDirs.has(node.path);
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleProjectDir(node.path)}
            className={`flex items-center w-full py-1 px-2 ${padding} text-xs font-mono text-fob-text-dim hover:text-fob-text hover:bg-fob-bg transition-colors`}
          >
            <span className="mr-1 text-[9px] opacity-60">{open ? "▼" : "▶"}</span>
            <span className="truncate">{node.name}</span>
          </button>
          {open && node.children && (
            <div className="border-l border-fob-border/50 ml-3">{node.children.map((c) => renderTreeNode(c, depth + 1))}</div>
          )}
        </div>
      );
    }
    const isMd = (node.ext ?? "").toLowerCase() === ".md";
    return (
      <button
        key={node.path}
        onClick={(e) => {
          const rel = node.path.replace(`${projectName}/`, "");
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            insertFileReference(node);
            return;
          }
          void loadProjectFile(rel);
        }}
        className={`flex items-center w-full py-1 px-2 ${padding} text-xs font-mono hover:bg-fob-bg transition-colors truncate ${
          activeNote === node.path ? "bg-fob-active text-fob-accent-text" : "text-fob-text-dim hover:text-fob-text"
        }`}
        title={`${node.name}${isMd ? "" : " — Ctrl/Shift+click to insert reference"}`}
      >
        <span className="mr-1.5 text-[10px] opacity-60">{isMd ? "📝" : "📄"}</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-fob-text-dim font-mono text-xs">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full bg-fob-surface text-fob-text">
      {/* Sidebar */}
      <div className="w-56 flex flex-col border-r border-fob-border bg-fob-surface">
        <div className="flex flex-col border-b border-fob-border">
          {/* Folder selector */}
          <div className="flex items-center gap-1 px-2 pt-2 pb-1">
            <select
              value={activeFolder}
              onChange={(e) => setActiveFolder(e.target.value)}
              className="flex-1 min-w-0 rounded bg-fob-bg px-1 py-0.5 text-[10px] text-fob-text-dim outline-none"
            >
              <option value="">/ root</option>
              {folders.map((f) => (
                <option key={f} value={f}>/{f}</option>
              ))}
            </select>
            <button
              onClick={() => setNewFolderInput((v) => !v)}
              className="rounded px-2 py-1.5 text-xs text-fob-text-dim hover:text-fob-orange"
              title="New folder"
            >+📁</button>
          </div>
          {newFolderInput && (
            <div className="flex items-center gap-1 px-2 pb-1.5">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder(newFolderName);
                  if (e.key === "Escape") { setNewFolderInput(false); setNewFolderName(""); }
                }}
                placeholder="folder name"
                className="flex-1 rounded bg-fob-bg px-1 py-0.5 text-[10px] text-fob-orange outline-none border border-fob-orange"
              />
              <button onClick={() => void createFolder(newFolderName)} className="text-xs text-fob-green px-2 py-1">✓</button>
            </div>
          )}
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-xs font-mono font-bold uppercase text-fob-orange">Notes</span>
            <button
              onClick={handleNewNote}
              className="text-sm font-mono px-3 py-1.5 rounded-l-xl bg-fob-green text-fob-accent-text font-bold hover:opacity-90"
            >
              + New
            </button>
          </div>
          <div className="px-2 pb-2">
            <input ref={searchInputRef} value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notes…"
              className="w-full rounded bg-fob-bg px-2 py-2 text-xs font-mono text-fob-text outline-none border border-fob-border focus:border-fob-orange" />
          </div>
        </div>

        {/* Project files tree */}
        {projectName && (
          <div className="border-b border-fob-border bg-fob-surface">
            <button
              onClick={() => setProjectTreeOpen((v) => !v)}
              className="flex items-center justify-between w-full px-3 py-1.5 text-xs font-mono font-bold uppercase text-fob-orange hover:bg-fob-bg transition-colors"
            >
              <span>{projectName}</span>
              <span className="text-[9px] opacity-60">{projectTreeOpen ? "▼" : "▶"}</span>
            </button>
            {projectTreeOpen && (
              <div className="max-h-96 overflow-y-auto py-1">
                {projectTree.length === 0 && (
                  <div className="px-3 py-2 text-[10px] font-mono text-fob-text-dim opacity-60">Empty project</div>
                )}
                {projectTree.map((node) => renderTreeNode(node, 0))}
              </div>
            )}
          </div>
        )}

        {/* Tag cloud */}
        {allTags.length > 0 && (
          <div className="border-b border-fob-border bg-fob-surface px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-mono font-bold uppercase text-fob-orange">Tags</span>
              {activeTag && (
                <button
                  onClick={() => setActiveTag(null)}
                  className="text-[10px] font-mono text-fob-text-dim hover:text-fob-red"
                >
                  clear
                </button>
              )}
            </div>
            <div className="max-h-32 overflow-y-auto flex flex-wrap gap-1">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag(tag)}
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors ${
                    activeTag === tag
                      ? "bg-fob-orange text-fob-accent-text"
                      : "bg-fob-border text-fob-text-dim hover:text-fob-text"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {searchResults !== null ? (
            searchResults.length === 0
              ? <div className="px-3 py-4 text-xs text-fob-text-dim font-mono">No matches.</div>
              : searchResults.map((r) => (
                <div key={r.name}
                  onClick={() => { handleSelectNote(r.name); setSearch(""); setSearchResults(null); setActiveTag(null); }}
                  className="px-3 py-2.5 text-xs font-mono border-b border-fob-border/50 cursor-pointer hover:bg-fob-bg transition-colors"
                >
                  <div className="truncate text-fob-text">{r.name}</div>
                  {r.snippet && <div className="text-[11px] text-fob-orange truncate mt-0.5 opacity-80">{r.snippet}</div>}
                </div>
              ))
          ) : (() => {
            const filtered = notes.filter((n) => {
              const text = `${n.title ?? n.name} ${n.name}`.toLowerCase();
              const matchesSearch = !search.trim() || text.includes(search.toLowerCase());
              const matchesTag = !activeTag || extractTags(`${n.title ?? ""} ${n.name}`).includes(activeTag);
              return matchesSearch && matchesTag;
            });
            const emptyMessage = search || activeTag ? "No matches." : "No notes yet.";
            if (filtered.length === 0) return (
              <div className="px-3 py-4 text-xs text-fob-text-dim font-mono">{emptyMessage}</div>
            );
            return filtered.map((n) => (
              <div key={n.name}
                className={`flex items-center justify-between px-3 py-2.5 text-xs font-mono border-b border-fob-border/50 transition-colors ${
                  activeNote === n.name ? "bg-fob-active text-fob-accent-text font-bold" : "text-fob-text-dim hover:text-fob-text hover:bg-fob-bg"
                }`}
              >
                {editingName === n.name ? (
                  <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(n.name); if (e.key === "Escape") setEditingName(null); }}
                    onBlur={() => commitRename(n.name)} autoFocus
                    className="flex-1 bg-fob-bg text-fob-text font-mono text-xs px-1 outline-none border border-fob-orange rounded" />
                ) : (
                  <button onClick={() => handleSelectNote(n.name)} className="flex-1 text-left min-w-0">
                    <div className="truncate text-sm">{n.title || n.name}</div>
                    <div className="text-[11px] opacity-50 font-mono truncate">{n.name} · {formatDate(n.updated_at)}</div>
                  </button>
                )}
                {editingName !== n.name && (
                  <div className="flex items-center flex-shrink-0">
                    <button onClick={() => startRename(n.name)} className="ml-1 text-fob-text-dim hover:text-fob-orange px-1" title="Rename">&#9998;</button>
                    <button onClick={() => handleDeleteNote(n.name)} className="ml-0.5 text-fob-text-dim hover:text-fob-red px-1" title="Delete">&#x2715;</button>
                  </div>
                )}
              </div>
            ));
          })()}
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar row 1: view mode + controls moved to left */}
        <div 
          className="flex items-center px-3 border-b border-fob-border bg-fob-surface"
          style={{
            height: '53px',
          }}
        >
          <div className="flex gap-1 items-center">
            {(["edit", "preview", "split"] as const).map((mode) => (
              <button key={mode} onClick={() => setViewModeAndConfig(mode)}
                className={`px-3 py-1.5 text-xs font-mono font-bold rounded transition-colors flex items-center justify-center ${viewMode === mode ? "bg-fob-orange text-fob-accent-text" : "bg-fob-border text-fob-text-dim hover:text-fob-text"}`}>
                {mode.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-4">
            {activeNote && <span className="text-xs font-mono text-fob-text-dim">{content.trim() ? `${content.trim().split(/\s+/).length}w` : "0w"} · {content.split("\n").length}L</span>}
            <button onClick={() => setFontSizeAndConfig(fontSize - 1)} className="rounded px-2 py-1 text-xs text-fob-text-dim hover:text-fob-text hover:bg-fob-border flex items-center justify-center" title="Smaller">A-</button>
            <button onClick={() => setFontSizeAndConfig(fontSize + 1)} className="rounded px-2 py-1 text-xs text-fob-text-dim hover:text-fob-text hover:bg-fob-border flex items-center justify-center" title="Larger">A+</button>
            {activeNote && readOnly && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-fob-border text-fob-text-dim" title="Read-only binary asset">🔒 Read-only</span>}
            {activeNote && !readOnly && <button onClick={() => void navigator.clipboard.writeText(content)} className="rounded px-2.5 py-1.5 text-xs text-fob-text-dim hover:text-fob-text hover:bg-fob-border flex items-center justify-center" title="Copy markdown">⎘</button>}
            {activeNote && !readOnly && <button onClick={flushSave} disabled={!dirty}
              className={`px-3 py-1.5 rounded text-xs font-bold flex items-center justify-center ${dirty ? "bg-fob-orange text-fob-accent-text hover:opacity-90" : "bg-fob-border text-fob-text-dim cursor-default"}`}>
              Save
            </button>}
            <span className={`text-xs font-mono ${dirty ? "text-fob-orange" : "text-fob-green"}`}>{activeNote && !readOnly ? (dirty ? "●" : "✓") : ""}</span>
          </div>
        </div>
        {/* Toolbar row 2: formatting bar (edit/split only) */}
        {activeNote && !readOnly && viewMode !== "preview" && (
          <div className="flex items-center gap-1 border-b border-fob-border bg-fob-surface px-2 py-1.5 flex-wrap">
            {([
              { label: "B",  title: "Bold",          wrap: ["**","**"] as [string,string], cls: "font-bold" },
              { label: "I",  title: "Italic",        wrap: ["_","_"]   as [string,string], cls: "italic" },
              { label: "~~", title: "Strikethrough", wrap: ["~~","~~"] as [string,string], cls: "" },
              { label: "`",  title: "Inline code",   wrap: ["`","`"]   as [string,string], cls: "font-mono" },
            ]).map(({ label, title, wrap, cls }) => (
              <button key={label} title={title}
                onClick={() => {
                  const ta = textareaRef.current; if (!ta) return;
                  const s = ta.selectionStart; const e = ta.selectionEnd;
                  const sel = content.slice(s, e) || "text";
                  const next = content.slice(0, s) + wrap[0] + sel + wrap[1] + content.slice(e);
                  handleContentChange(next);
                  requestAnimationFrame(() => { ta.setSelectionRange(s + wrap[0].length, s + wrap[0].length + sel.length); ta.focus(); });
                }}
                className={`rounded px-2.5 py-1.5 text-xs text-fob-text-dim hover:text-fob-text hover:bg-fob-border ${cls}`}>{label}</button>
            ))}
            <span className="mx-1 h-3 w-px bg-fob-border" />
            {(["# ","## ","### "] as const).map((ins, i) => (
              <button key={ins} title={`H${i+1}`}
                onClick={() => {
                  const ta = textareaRef.current; if (!ta) return;
                  const lineStart = content.lastIndexOf("\n", ta.selectionStart - 1) + 1;
                  const next = content.slice(0, lineStart) + ins + content.slice(lineStart).replace(/^#+\s*/, "");
                  handleContentChange(next);
                  requestAnimationFrame(() => ta.focus());
                }}
                className="rounded px-2.5 py-1.5 text-xs font-bold text-fob-text-dim hover:text-fob-text hover:bg-fob-border">{`H${i+1}`}</button>
            ))}
            <span className="mx-1 h-3 w-px bg-fob-border" />
            <button title="Task checkbox"
              onClick={() => {
                const ta = textareaRef.current; if (!ta) return;
                const lineStart = content.lastIndexOf("\n", ta.selectionStart - 1) + 1;
                const ins = "- [ ] ";
                const next = content.slice(0, lineStart) + ins + content.slice(lineStart);
                handleContentChange(next);
                requestAnimationFrame(() => { ta.setSelectionRange(lineStart + ins.length, lineStart + ins.length); ta.focus(); });
              }}
              className="rounded px-2.5 py-1.5 text-xs text-fob-text-dim hover:text-fob-text hover:bg-fob-border">☐</button>
            <button title="Horizontal rule"
              onClick={() => {
                const ta = textareaRef.current; if (!ta) return;
                const s = ta.selectionStart;
                const ins = "\n\n---\n\n";
                handleContentChange(content.slice(0, s) + ins + content.slice(s));
                requestAnimationFrame(() => { ta.setSelectionRange(s + ins.length, s + ins.length); ta.focus(); });
              }}
              className="rounded px-2.5 py-1.5 text-xs text-fob-text-dim hover:text-fob-text hover:bg-fob-border">—</button>
            <button title="Code block"
              onClick={() => {
                const ta = textareaRef.current; if (!ta) return;
                const s = ta.selectionStart; const e = ta.selectionEnd;
                const sel = content.slice(s, e) || "code";
                const ins = "```\n" + sel + "\n```";
                handleContentChange(content.slice(0, s) + ins + content.slice(e));
                requestAnimationFrame(() => { ta.setSelectionRange(s + 4, s + 4 + sel.length); ta.focus(); });
              }}
              className="rounded px-2.5 py-1.5 text-xs font-mono text-fob-text-dim hover:text-fob-text hover:bg-fob-border">```</button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {!activeNote ? (
            <div className="flex items-center justify-center h-full text-fob-text-dim font-mono text-xs">
              Select a note or create a new one.
            </div>
          ) : viewMode === "edit" ? (
            <textarea
              ref={textareaRef}
              readOnly={readOnly}
              value={toDisplay(content, expandedLines)}
              onChange={(e) => { if (readOnly) return; handleContentChange(fromDisplay(e.target.value)); }}
              onClick={handleTextareaClick}
              onKeyDown={(e) => { if (readOnly) return;                 const ctrl = e.ctrlKey || e.metaKey;
                if (ctrl && e.key === "z" && !e.shiftKey) {
                  e.preventDefault();
                  const idx = historyIdxRef.current;
                  if (idx > 0) {
                    historySkipRef.current = true;
                    const prev = historyRef.current[idx - 1];
                    historyIdxRef.current = idx - 1;
                    setContent(prev); setDirty(true); scheduleSave();
                    historySkipRef.current = false;
                  }
                  return;
                }
                if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
                  e.preventDefault();
                  const idx = historyIdxRef.current;
                  if (idx < historyRef.current.length - 1) {
                    historySkipRef.current = true;
                    const next2 = historyRef.current[idx + 1];
                    historyIdxRef.current = idx + 1;
                    setContent(next2); setDirty(true); scheduleSave();
                    historySkipRef.current = false;
                  }
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const ta = e.currentTarget;
                  const s = ta.selectionStart; const end = ta.selectionEnd;
                  const disp = toDisplay(content, expandedLines);
                  const next = fromDisplay(disp.slice(0, s) + "  " + disp.slice(end));
                  handleContentChange(next);
                  requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
                }
              }}
              style={{ fontSize }}
              className="w-full h-full bg-fob-bg text-fob-text font-mono p-4 resize-none outline-none"
              spellCheck={false}
            />
          ) : viewMode === "preview" ? (
            <div className="w-full h-full overflow-auto p-4 max-w-none text-fob-text">
              <NoteCellRenderer cells={parseNoteCells(content)} onUpdateLayers={handleUpdateLayers} onWikiLink={handleWikiLink} onTagClick={handleTagClick} projectName={projectName ?? undefined} />
            </div>
          ) : (
            <div className="flex h-full">
              <textarea
                ref={textareaRef}
                readOnly={readOnly}
                value={toDisplay(content, expandedLines)}
                onChange={(e) => { if (readOnly) return; handleContentChange(fromDisplay(e.target.value)); }}
                onClick={handleTextareaClick}
                onKeyDown={(e) => { if (readOnly) return;                   const ctrl = e.ctrlKey || e.metaKey;
                  if (ctrl && e.key === "z" && !e.shiftKey) {
                    e.preventDefault();
                    const idx = historyIdxRef.current;
                    if (idx > 0) {
                      historySkipRef.current = true;
                      const prev = historyRef.current[idx - 1];
                      historyIdxRef.current = idx - 1;
                      setContent(prev); setDirty(true); scheduleSave();
                      historySkipRef.current = false;
                    }
                    return;
                  }
                  if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
                    e.preventDefault();
                    const idx = historyIdxRef.current;
                    if (idx < historyRef.current.length - 1) {
                      historySkipRef.current = true;
                      const next2 = historyRef.current[idx + 1];
                      historyIdxRef.current = idx + 1;
                      setContent(next2); setDirty(true); scheduleSave();
                      historySkipRef.current = false;
                    }
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const ta = e.currentTarget;
                    const s = ta.selectionStart; const end = ta.selectionEnd;
                    const disp = toDisplay(content, expandedLines);
                    const next = fromDisplay(disp.slice(0, s) + "  " + disp.slice(end));
                    handleContentChange(next);
                    requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
                  }
                }}
                style={{ fontSize }}
                className="w-1/2 h-full bg-fob-bg text-fob-text font-mono p-4 resize-none outline-none border-r border-fob-border"
                spellCheck={false}
              />
              <div className="w-1/2 h-full overflow-auto p-4 max-w-none text-fob-text">
                <NoteCellRenderer cells={parseNoteCells(content)} onUpdateLayers={handleUpdateLayers} onWikiLink={handleWikiLink} onTagClick={handleTagClick} projectName={projectName ?? undefined} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

class NoteForgePlugin implements PluginLifecycle {
  private root?: Root;

  mount(container: HTMLElement, bus: PluginBus): void {
    this.root = createRoot(container);
    this.root.render(<PluginErrorBoundary pluginId="noteforge"><NoteForgeApp bus={bus} /></PluginErrorBoundary>);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = undefined;
  }
}

export default NoteForgePlugin;
