import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Components } from "react-markdown";
import type { AnnotationLayer } from "../lensforge/types";
import type { Plugin } from "unified";
import type { Root, Text, Link } from "mdast";
import { visit } from "unist-util-visit";
import { formatSi } from "../pocketforge/types";

// ── Lightbox ──────────────────────────────────────────────────────────────────
// Rendered via a portal to avoid nesting a fixed div inside a markdown <p>.
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let el = document.getElementById("noteforge-lightbox-root");
    if (!el) {
      el = document.createElement("div");
      el.id = "noteforge-lightbox-root";
      document.body.appendChild(el);
    }
    setMount(el);
    return () => {
      if (el && el.childNodes.length === 0) {
        document.body.removeChild(el);
      }
    };
  }, []);
  const content = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded shadow-2xl ring-1 ring-fob-border"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute left-4 top-4 rounded-full bg-fob-surface px-3 py-1 text-xs font-bold text-fob-text hover:text-fob-red"
      >
        ✕ Close
      </button>
    </div>
  );
  return mount ? createPortal(content, mount) : null;
}

function resolveAssetUrl(src: string | undefined, projectName: string | undefined): string | undefined {
  if (!src || !projectName) return src;
  if (/^(https?:|data:|\/|#|wikilink:|tag:)/.test(src)) return src;
  return `/api/v1/workspace/projects/${encodeURIComponent(projectName)}/rawfile?path=${encodeURIComponent(src)}`;
}

// ── Image renderer ────────────────────────────────────────────────────────────
function NoteImage({ src, alt, projectName }: { src?: string; alt?: string; projectName?: string }) {
  const [lightbox, setLightbox] = useState(false);
  if (!src) return null;
  if (src.startsWith("data:") && !src.startsWith("data:image/")) return null;
  const resolved = resolveAssetUrl(src, projectName) ?? src;
  const isBase64 = src.startsWith("data:image/");
  return (
    <>
      <span className="block my-3">
        <img
          src={resolved}
          alt={alt ?? ""}
          onClick={() => setLightbox(true)}
          className={`max-w-full rounded border border-fob-border shadow cursor-zoom-in ${isBase64 ? "w-full object-contain" : ""}`}
          style={isBase64 ? { maxHeight: "420px" } : undefined}
        />
        {alt && alt !== "lens-capture" && (
          <span className="mt-1 block text-center text-[10px] font-mono text-fob-text-dim">{alt}</span>
        )}
      </span>
      {lightbox && <Lightbox src={resolved} alt={alt ?? ""} onClose={() => setLightbox(false)} />}
    </>
  );
}

// ── Annotation layer SVG preview ──────────────────────────────────────────────
function AnnotationPreview({ layers }: { layers: AnnotationLayer[] }) {
  const W = 320;
  const H = 240;
  return (
    <div className="my-2 rounded border border-fob-border bg-black/60 p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-wider text-fob-orange">Annotation Layers</span>
        <span className="text-[9px] text-fob-text-dim">{layers.length} layer{layers.length !== 1 ? "s" : ""}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-black/40" style={{ maxHeight: 180 }}>
        <defs>
          {layers.map((l) => (
            <marker key={l.id} id={`nf-arrow-${l.id}`} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={l.color} />
            </marker>
          ))}
        </defs>
        {layers.filter((l) => l.visible).map((layer) =>
          layer.items.map((ann, i) => (
            <g key={`${layer.id}-${i}`}>
              {(ann.type === "ruler" || ann.type === "arrow") && ann.x2 != null && ann.y2 != null && (
                <>
                  <line
                    x1={ann.x1} y1={ann.y1} x2={ann.x2} y2={ann.y2}
                    stroke={ann.color} strokeWidth={1.5}
                    strokeDasharray={ann.type === "ruler" ? "4 2" : undefined}
                    markerEnd={ann.type === "arrow" ? `url(#nf-arrow-${layer.id})` : undefined}
                  />
                  {ann.type === "ruler" && (
                    <>
                      <circle cx={ann.x1} cy={ann.y1} r={3} fill={ann.color} />
                      <circle cx={ann.x2} cy={ann.y2} r={3} fill={ann.color} />
                      <text x={(ann.x1 + ann.x2) / 2} y={(ann.y1 + ann.y2) / 2 - 4}
                        fill={ann.color} fontSize={9} fontFamily="monospace" textAnchor="middle">
                        {Math.round(Math.sqrt((ann.x2 - ann.x1) ** 2 + (ann.y2 - ann.y1) ** 2))}px
                      </text>
                    </>
                  )}
                </>
              )}
              {ann.type === "freehand" && ann.points && ann.points.length > 1 && (
                <polyline
                  points={ann.points.map(([x, y]) => `${x},${y}`).join(" ")}
                  stroke={ann.color} strokeWidth={1.5} fill="none"
                  strokeLinejoin="round" strokeLinecap="round"
                />
              )}
              {ann.type === "text" && ann.text && (
                <text x={ann.x1} y={ann.y1} fill={ann.color} fontSize={10}
                  fontFamily="monospace" stroke="black" strokeWidth={0.5} paintOrder="stroke">
                  {ann.text}
                </text>
              )}
            </g>
          ))
        )}
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {layers.map((l) => (
          <span key={l.id} className="flex items-center gap-1 text-[9px] font-mono text-fob-text-dim">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
            {l.name} ({l.items.length})
          </span>
        ))}
      </div>
    </div>
  );
}

// ── PocketForge capture preview card ──────────────────────────────────────────
interface PocketForgeCapture {
  plugin?: string;
  name?: string;
  timestamp?: number;
  value?: number;
  unit?: string;
  meta?: {
    mode?: string;
    sampleCount?: number;
    durationMs?: number;
    [key: string]: unknown;
  };
}

function isPocketForgeCapture(parsed: unknown): parsed is PocketForgeCapture {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as PocketForgeCapture).plugin === "pocketforge" &&
    typeof (parsed as PocketForgeCapture).value === "number"
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function PokitCapturePreview({ capture }: { capture: PocketForgeCapture }) {
  const ts = capture.timestamp ? new Date(capture.timestamp).toLocaleString() : null;
  const mode = capture.meta?.mode ?? "Unknown";
  const sampleCount = capture.meta?.sampleCount;
  const duration = capture.meta?.durationMs;
  return (
    <div className="my-2 rounded border border-fob-border bg-fob-surface p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-fob-orange">PocketForge</span>
        {capture.name && <span className="text-[10px] text-fob-text-dim">{capture.name}</span>}
      </div>
      <div className="mt-1 text-2xl font-mono text-fob-text">
        {formatSi(capture.value ?? 0, capture.unit ?? "")}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] font-mono text-fob-text-dim">
        <span>Mode: {mode}</span>
        {sampleCount !== undefined && <span>Samples: {sampleCount.toLocaleString()}</span>}
        {duration !== undefined && <span>Duration: {formatDuration(duration)}</span>}
        {ts && <span>Time: {ts}</span>}
      </div>
    </div>
  );
}

// ── Code block renderer ───────────────────────────────────────────────────────
function NoteCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = className?.replace("language-", "") ?? "";
  const raw = String(children ?? "").trim();

  if (lang === "json" || lang === "") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && "items" in parsed[0]) {
        return <AnnotationPreview layers={parsed as AnnotationLayer[]} />;
      }
      if (isPocketForgeCapture(parsed)) {
        return <PokitCapturePreview capture={parsed} />;
      }
    } catch { /* not JSON or not a known preview — fall through */ }
  }

  return (
    <code className={`rounded bg-fob-surface px-1 py-0.5 font-mono text-[11px] text-fob-orange ${className ?? ""}`}>
      {children}
    </code>
  );
}

function NotePreBlock({ children }: { children?: React.ReactNode }) {
  return (
    <pre className="my-2 overflow-x-auto rounded border border-fob-border bg-fob-surface p-3 font-mono text-[11px] text-fob-text">
      {children}
    </pre>
  );
}

// ── Details / summary renderer ────────────────────────────────────────────────
// With rehype-raw, <summary> children arrive as a React element with type="summary".
// We extract its text content for the button label and render the rest as body.
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in (node as object)) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

function NoteDetails({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const kids = Array.isArray(children) ? children : [children];
  const summaryEl = kids.find((c) => {
    if (!c || typeof c !== "object") return false;
    const el = c as React.ReactElement;
    return el.type === "summary" || (typeof el.type === "string" && el.type === "summary");
  });
  const summaryText = summaryEl ? extractText(summaryEl) : "Details";
  const body = kids.filter((c) => c !== summaryEl);
  return (
    <div className="my-2 rounded border border-fob-border bg-fob-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-bold text-fob-orange hover:bg-fob-bg"
      >
        <span className="font-mono text-xs">{open ? "▼" : "▶"}</span>
        <span>{summaryText}</span>
      </button>
      {open && (
        <div className="border-t border-fob-border px-3 py-2 text-sm">
          {body}
        </div>
      )}
    </div>
  );
}

const TAG_RE = /#[a-zA-Z][a-zA-Z0-9_-]*/g;

// ── WikiLink remark plugin ───────────────────────────────────────────────────
// Transforms [[Note Title]] into a link with href="wikilink:Note Title"
export const remarkWikiLinks: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent) => {
    if (!parent || index === undefined) return;
    const re = /\[\[([^\]]+)\]\]/g;
    const parts: (Text | Link)[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(node.value)) !== null) {
      if (match.index > last) {
        parts.push({ type: "text", value: node.value.slice(last, match.index) });
      }
      parts.push({
        type: "link",
        url: `wikilink:${match[1]}`,
        title: null,
        children: [{ type: "text", value: match[1] }],
      });
      last = match.index + match[0].length;
    }
    if (parts.length === 0) return;
    if (last < node.value.length) {
      parts.push({ type: "text", value: node.value.slice(last) });
    }
    parent.children.splice(index, 1, ...parts);
  });
};

// ── Tag remark plugin ─────────────────────────────────────────────────────────
// Transforms #tag into a link with href="tag:tagname"
export const remarkTags: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent) => {
    if (!parent || index === undefined) return;
    const parts: (Text | Link)[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(node.value)) !== null) {
      if (match.index > last) {
        parts.push({ type: "text", value: node.value.slice(last, match.index) });
      }
      parts.push({
        type: "link",
        url: `tag:${match[0]}`,
        title: null,
        children: [{ type: "text", value: match[0] }],
      });
      last = match.index + match[0].length;
    }
    if (parts.length === 0) return;
    if (last < node.value.length) {
      parts.push({ type: "text", value: node.value.slice(last) });
    }
    parent.children.splice(index, 1, ...parts);
  });
};

// ── noteMarkdownComponents factory ────────────────────────────────────────────
export function buildNoteMarkdownComponents(
  onWikiLink?: (title: string) => void,
  onTagClick?: (tag: string) => void,
  projectName?: string
): Components {
  return {
    ...noteMarkdownComponents,
    img: ({ src, alt }) => <NoteImage src={src} alt={alt} projectName={projectName} />,
    a: ({ href, children }) => {
      if (href?.startsWith("wikilink:")) {
        const title = decodeURIComponent(href.slice("wikilink:".length));
        return (
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); onWikiLink?.(title); }}
            className="text-fob-orange underline underline-offset-2 hover:text-fob-orange/80 font-mono text-sm cursor-pointer"
            title={`Open note: ${title}`}
          >
            {children}
          </a>
        );
      }
      if (href?.startsWith("tag:")) {
        const tag = decodeURIComponent(href.slice("tag:".length));
        return (
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); onTagClick?.(tag); }}
            className="inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-fob-orange/20 text-fob-orange hover:bg-fob-orange hover:text-fob-accent-text cursor-pointer transition-colors"
            title={`Filter by ${tag}`}
          >
            {children}
          </a>
        );
      }
      const resolved = resolveAssetUrl(href, projectName) ?? href;
      return <a href={resolved} target="_blank" rel="noreferrer" className="text-fob-orange underline underline-offset-2 hover:text-fob-orange/80">{children}</a>;
    },
  };
}

// ── Export ────────────────────────────────────────────────────────────────────
export const noteMarkdownComponents: Components = {
  img: ({ src, alt }) => <NoteImage src={src} alt={alt} projectName={undefined} />,
  code: ({ className, children }) => <NoteCode className={className}>{children}</NoteCode>,
  pre: ({ children }) => <NotePreBlock>{children}</NotePreBlock>,
  details: ({ children }) => <NoteDetails>{children}</NoteDetails>,
  summary: () => null,
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-bold text-fob-orange font-mono">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-base font-bold text-fob-text font-mono">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-bold text-fob-text-dim font-mono">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 text-sm leading-relaxed text-fob-text">{children}</p>,
  strong: ({ children }) => <strong className="font-bold text-fob-text">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-fob-orange pl-3 text-sm italic text-fob-text-dim">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs font-mono">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-fob-border bg-fob-surface px-2 py-1 text-left text-fob-orange">{children}</th>,
  td: ({ children }) => <td className="border border-fob-border px-2 py-1 text-fob-text">{children}</td>,
};
