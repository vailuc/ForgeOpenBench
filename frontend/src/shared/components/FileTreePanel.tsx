import { useState, useEffect } from "react";
import { wsUrl } from "../../core/ws_url";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  ext?: string;
  size?: number;
  children?: TreeNode[];
}

interface FileTreePanelProps {
  projectName: string | null;
  open: boolean;
  onOpenFile?: (path: string, ext: string) => void;
}

const FOLDER_ICONS: Record<string, string> = {
  notes: "📝",
  captures: "📷",
  waveforms: "〜",
  firmware: "⚙",
  scripts: "⚡",
};

const FILE_ICONS: Record<string, string> = {
  ".md": "📄",
  ".png": "🖼",
  ".jpg": "🖼",
  ".jpeg": "🖼",
  ".bin": "🔲",
  ".hex": "🔲",
  ".py": "🐍",
  ".js": "📜",
  ".ts": "📜",
  ".json": "{}",
  ".csv": "📊",
};

function fileIcon(ext: string) {
  return FILE_ICONS[ext] ?? "📄";
}

function TreeNodeRow({
  node,
  depth,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  onOpenFile?: (path: string, ext: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);

  const indent = depth * 10;

  if (node.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 w-full px-2 py-0.5 text-left text-[11px] font-mono text-fob-text-dim hover:text-fob-text hover:bg-fob-surface-hover transition-colors"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          <span className="text-[9px] opacity-50">{expanded ? "▼" : "▶"}</span>
          <span>{FOLDER_ICONS[node.name] ?? "📁"}</span>
          <span className="uppercase tracking-wide font-bold text-[10px]">{node.name}</span>
          {node.children && node.children.length > 0 && (
            <span className="ml-auto text-[9px] opacity-40">{node.children.length}</span>
          )}
        </button>
        {expanded && node.children && (
          <div>
            {node.children.length === 0 ? (
              <div
                className="text-[10px] font-mono text-fob-text-dim opacity-40 py-0.5"
                style={{ paddingLeft: `${18 + indent}px` }}
              >
                empty
              </div>
            ) : (
              node.children.map((child) => (
                <TreeNodeRow
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  onOpenFile={onOpenFile}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onOpenFile?.(node.path, node.ext ?? "")}
      className="flex items-center gap-1.5 w-full px-2 py-0.5 text-left text-[11px] font-mono text-fob-text-dim hover:text-fob-orange hover:bg-fob-surface-hover transition-colors"
      style={{ paddingLeft: `${8 + indent}px` }}
      title={node.path}
    >
      <span>{fileIcon(node.ext ?? "")}</span>
      <span className="truncate flex-1">{node.name}</span>
    </button>
  );
}

export function FileTreePanel({ projectName, open, onOpenFile }: FileTreePanelProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !projectName) return;
    setLoading(true);
    setError(null);
    const base = wsUrl("").replace(/^ws/, "http").replace(/\/+$/, "");
    fetch(`${base}/api/v1/workspace/projects/${encodeURIComponent(projectName)}/tree`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => { setTree(data.tree ?? []); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [open, projectName]);

  if (!open) return null;

  return (
    <div className="w-48 flex-shrink-0 bg-fob-bg border-r border-fob-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-2 py-1.5 border-b border-fob-border flex-shrink-0">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-fob-text-dim">
          {projectName ?? "No project"}
        </span>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="text-[10px] font-mono text-fob-text-dim px-3 py-2">Loading…</div>
        )}
        {error && (
          <div className="text-[10px] font-mono text-fob-red px-3 py-2">Error: {error}</div>
        )}
        {!loading && !error && tree.map((node) => (
          <TreeNodeRow key={node.path} node={node} depth={0} onOpenFile={onOpenFile} />
        ))}
        {!loading && !error && tree.length === 0 && (
          <div className="text-[10px] font-mono text-fob-text-dim opacity-40 px-3 py-2">Empty project</div>
        )}
      </div>
    </div>
  );
}
