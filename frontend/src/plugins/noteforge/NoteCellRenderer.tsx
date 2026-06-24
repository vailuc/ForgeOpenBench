import { useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { NoteCell, LensCaptureCell, CodeCell } from "./noteCells";
import { noteMarkdownComponents, remarkWikiLinks, remarkTags, buildNoteMarkdownComponents } from "./noteComponents";
import type { AnnotationLayer, AnnotationItem, AnnotationToolType } from "../lensforge/types";
import { defaultLayer } from "../lensforge/types";

const LAYER_COLORS = ["#ff6b00", "#60a5fa", "#86efac", "#f87171", "#c084fc", "#fbbf24"];

// ── Lightbox (shared) ─────────────────────────────────────────────────────────
function Lightbox({
  src, onClose, layers, imgW, imgH, uid = "lb",
}: {
  src: string; onClose: () => void;
  layers?: AnnotationLayer[]; imgW?: number; imgH?: number; uid?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt="capture"
          className="max-h-[92vh] max-w-[92vw] rounded shadow-2xl ring-1 ring-fob-border block"
        />
        {layers && imgW && imgH && (
          <AnnotationOverlay layers={layers} imgW={imgW} imgH={imgH} uid={uid} />
        )}
      </div>
      <button
        onClick={onClose}
        className="absolute left-5 top-5 rounded-full bg-fob-surface px-3 py-1 text-xs font-bold text-fob-text hover:text-fob-red ring-1 ring-fob-border"
      >
        ✕
      </button>
    </div>
  );
}

// ── Annotation overlay on top of the captured image ───────────────────────────
function AnnotationOverlay({ layers, imgW, imgH, uid = "ncr" }: { layers: AnnotationLayer[]; imgW: number; imgH: number; uid?: string }) {
  if (layers.every((l) => l.items.length === 0)) return null;
  return (
    <svg
      viewBox={`0 0 ${imgW} ${imgH}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {layers.map((l) => (
          <marker key={l.id} id={`${uid}-arrow-${l.id}`} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
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
                  stroke={ann.color} strokeWidth={ann.strokeWidth ?? 1.5}
                  strokeDasharray={ann.type === "ruler" ? "4 2" : undefined}
                  markerEnd={ann.type === "arrow" ? `url(#${uid}-arrow-${layer.id})` : undefined}
                />
                {ann.type === "ruler" && (
                  <>
                    <circle cx={ann.x1} cy={ann.y1} r={3} fill={ann.color} />
                    <circle cx={ann.x2} cy={ann.y2} r={3} fill={ann.color} />
                    <text
                      x={(ann.x1 + ann.x2) / 2} y={(ann.y1 + ann.y2) / 2 - 5}
                      fill={ann.color} fontSize={11} fontFamily="monospace" textAnchor="middle"
                      stroke="black" strokeWidth={0.4} paintOrder="stroke"
                    >
                      {Math.round(Math.sqrt((ann.x2 - ann.x1) ** 2 + (ann.y2 - ann.y1) ** 2))}px
                    </text>
                  </>
                )}
              </>
            )}
            {ann.type === "freehand" && ann.points && ann.points.length > 1 && (
              <polyline
                points={ann.points.map(([x, y]) => `${x},${y}`).join(" ")}
                stroke={ann.color} strokeWidth={ann.strokeWidth ?? 1.5} fill="none"
                strokeLinejoin="round" strokeLinecap="round"
              />
            )}
            {ann.type === "text" && ann.text && (
              <text
                x={ann.x1} y={ann.y1} fill={ann.color} fontSize={ann.strokeWidth ? 10 + ann.strokeWidth * 2 : 12}
                fontFamily="monospace" stroke="black" strokeWidth={0.5} paintOrder="stroke"
              >
                {ann.text}
              </text>
            )}
          </g>
        ))
      )}
    </svg>
  );
}

// ── LensCapture cell ──────────────────────────────────────────────────────────
function LensCaptureCellView({
  cell,
  onUpdateLayers,
}: {
  cell: LensCaptureCell;
  onUpdateLayers?: (imageDataUrl: string, layers: AnnotationLayer[]) => void;
}) {
  const [lightbox, setLightbox] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  // Local editable copy of layers
  const [layers, setLayers] = useState<AnnotationLayer[]>(cell.layers);
  // Editing state
  const [expandedLayer, setExpandedLayer] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  // Drawing tool state
  const [activeTool, setActiveTool] = useState<AnnotationToolType | null>(null);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [drawColor, setDrawColor] = useState("#ff6b00");
  const [drawWidth, setDrawWidth] = useState(2);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const freehandPointsRef = useRef<[number, number][]>([]);
  const [liveEnd, setLiveEnd] = useState<{ x: number; y: number } | null>(null);
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);

  const commit = (next: AnnotationLayer[]) => {
    setLayers(next);
    onUpdateLayers?.(cell.imageDataUrl, next);
  };

  const toggleLayer = (id: string) =>
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const addLayer = () => {
    const idx = layers.length;
    const color = LAYER_COLORS[idx % LAYER_COLORS.length];
    const newLayer = defaultLayer(`layer-${Date.now()}`, `Layer ${idx + 1}`, color);
    const next = [...layers, newLayer];
    commit(next);
    setExpandedLayer(newLayer.id);
  };

  const deleteLayer = (id: string) => {
    const next = layers.filter((l) => l.id !== id);
    commit(next.length ? next : []);
    if (expandedLayer === id) setExpandedLayer(null);
  };

  const renameLayer = (id: string, name: string) => {
    commit(layers.map((l) => l.id === id ? { ...l, name } : l));
    setRenamingId(null);
  };

  const setLayerColor = (id: string, color: string) => {
    commit(layers.map((l) => l.id === id ? { ...l, color } : l));
  };

  const deleteItem = (layerId: string, itemIdx: number) => {
    commit(layers.map((l) =>
      l.id === layerId ? { ...l, items: l.items.filter((_, i) => i !== itemIdx) } : l
    ));
  };

  const clearLayer = (id: string) => {
    commit(layers.map((l) => l.id === id ? { ...l, items: [] } : l));
  };

  const visibleLayers = layers.map((l) => ({ ...l, visible: !hiddenLayers.has(l.id) }));
  const drawingActive = !!activeTool && !!onUpdateLayers;

  // Returns {layerId, base} where base is the layers array guaranteed to contain layerId.
  // Creates a new layer inline if none exist — avoiding the stale-closure bug where
  // commit([newLayer]) wouldn't be visible to the calling onPointerUp closure.
  const resolveLayerBase = (): { layerId: string; base: AnnotationLayer[] } => {
    if (activeLayerId && layers.find((l) => l.id === activeLayerId))
      return { layerId: activeLayerId, base: layers };
    if (layers.length > 0) {
      setActiveLayerId(layers[0].id);
      return { layerId: layers[0].id, base: layers };
    }
    const newLayer = defaultLayer(`layer-${Date.now()}`, "Layer 1", drawColor);
    setActiveLayerId(newLayer.id);
    return { layerId: newLayer.id, base: [newLayer] };
  };

  const getRelPos = (e: React.PointerEvent): { x: number; y: number } => {
    const el = imgContainerRef.current;
    if (!el || !imgSize) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const scaleX = imgSize.w / rect.width;
    const scaleY = imgSize.h / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!drawingActive) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const pos = getRelPos(e);
    if (activeTool === "text") { setPendingText(pos); return; }
    drawStartRef.current = pos;
    if (activeTool === "freehand") freehandPointsRef.current = [[pos.x, pos.y]];
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingActive || !drawStartRef.current) return;
    const pos = getRelPos(e);
    if (activeTool === "freehand") freehandPointsRef.current.push([pos.x, pos.y]);
    else setLiveEnd(pos);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drawingActive || !drawStartRef.current) return;
    const pos = getRelPos(e);
    const { layerId, base } = resolveLayerBase();
    const layer = base.find((l) => l.id === layerId);
    const color = layer?.color ?? drawColor;
    const strokeWidth = layer?.strokeWidth ?? drawWidth;
    const addItem = (item: AnnotationItem) => {
      commit(base.map((l) => l.id === layerId ? { ...l, items: [...l.items, item] } : l));
    };
    if (activeTool === "freehand" && freehandPointsRef.current.length > 1) {
      addItem({ type: "freehand", x1: freehandPointsRef.current[0][0], y1: freehandPointsRef.current[0][1], points: [...freehandPointsRef.current], color, strokeWidth });
      freehandPointsRef.current = [];
    } else if ((activeTool === "arrow" || activeTool === "ruler") && drawStartRef.current) {
      if (Math.abs(pos.x - drawStartRef.current.x) > 4 || Math.abs(pos.y - drawStartRef.current.y) > 4)
        addItem({ type: activeTool, x1: drawStartRef.current.x, y1: drawStartRef.current.y, x2: pos.x, y2: pos.y, color, strokeWidth });
    }
    drawStartRef.current = null;
    setLiveEnd(null);
  };

  const commitText = (text: string) => {
    if (!pendingText || !text.trim()) { setPendingText(null); return; }
    const { layerId, base } = resolveLayerBase();
    const layer = base.find((l) => l.id === layerId);
    const color = layer?.color ?? drawColor;
    commit(base.map((l) => l.id === layerId ? { ...l, items: [...l.items, { type: "text" as AnnotationToolType, x1: pendingText.x, y1: pendingText.y, text, color, strokeWidth: drawWidth }] } : l));
    setPendingText(null);
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-fob-border bg-fob-surface shadow-sm">
      <div className="flex">
        {/* Image column */}
        <div
          ref={imgContainerRef}
          className={`relative flex-1 bg-black min-w-0 ${drawingActive ? "cursor-crosshair" : "cursor-zoom-in"}`}
          onClick={!drawingActive ? () => setLightbox(true) : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <img
            src={cell.imageDataUrl}
            alt={cell.alt}
            className="w-full object-contain pointer-events-none"
            style={{ maxHeight: "420px" }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
          />
          {imgSize && (
            <AnnotationOverlay layers={visibleLayers} imgW={imgSize.w} imgH={imgSize.h} uid={cell.id} />
          )}
          {/* Live preview of in-progress stroke */}
          {drawingActive && imgSize && liveEnd && drawStartRef.current && (activeTool === "arrow" || activeTool === "ruler") && (
            <svg viewBox={`0 0 ${imgSize.w} ${imgSize.h}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
              <line x1={drawStartRef.current.x} y1={drawStartRef.current.y} x2={liveEnd.x} y2={liveEnd.y}
                stroke={drawColor} strokeWidth={drawWidth} strokeDasharray={activeTool === "ruler" ? "4 2" : undefined}
                strokeOpacity={0.7} />
            </svg>
          )}
          {/* Text input overlay */}
          {pendingText && imgSize && (
            <div className="absolute inset-0 pointer-events-none" style={{ aspectRatio: `${imgSize.w}/${imgSize.h}` }}>
              <input autoFocus type="text" placeholder="Type text, Enter to place"
                className="pointer-events-auto absolute bg-black/70 text-white border border-fob-orange rounded px-1 py-0.5 text-[11px] font-mono outline-none"
                style={{ left: `${(pendingText.x / imgSize.w) * 100}%`, top: `${(pendingText.y / imgSize.h) * 100}%`, transform: "translateY(-100%)" }}
                onKeyDown={(e) => { if (e.key === "Enter") commitText(e.currentTarget.value); if (e.key === "Escape") setPendingText(null); }}
                onBlur={(e) => commitText(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="flex w-52 flex-shrink-0 flex-col gap-1.5 border-l border-fob-border bg-fob-bg p-2 text-[9px] overflow-y-auto" style={{ maxHeight: "420px" }}>
          {/* Caption */}
          <div className="font-mono text-fob-text-dim leading-tight">
            {cell.alt && cell.alt !== "lens-capture" ? cell.alt : "LensForge capture"}
          </div>

          {/* Meta (pane / label / filter) */}
          {cell.meta && (
            <div className="border-t border-fob-border pt-1.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={noteMarkdownComponents}>
                {cell.meta}
              </ReactMarkdown>
            </div>
          )}

          {/* Drawing toolbar */}
          {onUpdateLayers && (
            <div className="border-t border-fob-border pt-1.5 flex flex-col gap-1.5">
              <span className="font-bold uppercase tracking-wider text-fob-orange">Draw</span>
              {/* Tools + color on one row */}
              <div className="flex items-center gap-1">
                {(["freehand", "arrow", "ruler", "text"] as AnnotationToolType[]).map((tool) => (
                  <button key={tool} onClick={(e) => { e.stopPropagation(); setActiveTool(activeTool === tool ? null : tool); }}
                    className={`flex-1 rounded py-0.5 font-mono text-center transition-colors ${activeTool === tool ? "bg-fob-orange text-fob-accent-text font-bold" : "bg-fob-border text-fob-text-dim hover:text-fob-text"}`}
                    title={tool}>
                    {tool === "freehand" ? "✏" : tool === "arrow" ? "→" : tool === "ruler" ? "⟼" : "T"}
                  </button>
                ))}
                <input type="color" value={drawColor} onChange={(e) => setDrawColor(e.target.value)}
                  className="h-5 w-6 flex-shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" title="Draw colour" />
              </div>
              {/* Width buttons */}
              <div className="flex items-center gap-1">
                <span className="text-fob-text-dim flex-shrink-0">Width:</span>
                {[1, 2, 3, 5, 8].map((w) => (
                  <button key={w} onClick={() => setDrawWidth(w)}
                    className={`flex-1 rounded py-0.5 font-mono transition-colors ${drawWidth === w ? "bg-fob-orange text-fob-accent-text font-bold" : "bg-fob-border text-fob-text-dim hover:text-fob-text"}`}>
                    {w}
                  </button>
                ))}
              </div>
              {/* Active layer selector */}
              {layers.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-fob-text-dim">onto layer:</span>
                  <div className="flex flex-wrap gap-1">
                    {layers.map((l) => (
                      <button key={l.id} onClick={(e) => { e.stopPropagation(); setActiveLayerId(l.id); }}
                        className={`flex items-center gap-0.5 rounded px-1 py-0.5 font-mono transition-colors ${activeLayerId === l.id ? "bg-fob-surface border border-fob-orange text-fob-text" : "bg-fob-border text-fob-text-dim hover:text-fob-text"}`}>
                        <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: l.color }} />
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Layers header */}
          <div className="border-t border-fob-border pt-1.5 flex items-center gap-1">
            <span className="flex-1 font-bold uppercase tracking-wider text-fob-orange">Layers</span>
            {onUpdateLayers && (
              <button onClick={(e) => { e.stopPropagation(); addLayer(); }}
                className="rounded bg-fob-border px-1.5 py-0.5 text-fob-text-dim hover:text-fob-orange transition-colors"
                title="Add layer">+ Add</button>
            )}
          </div>

          {/* Layer list */}
          {layers.map((layer) => {
            const hidden = hiddenLayers.has(layer.id);
            const expanded = expandedLayer === layer.id;
            return (
              <div key={layer.id} className="flex flex-col rounded border border-fob-border overflow-hidden">
                {/* Layer row */}
                <div
                  className={`flex items-center gap-1 px-1.5 py-0.5 cursor-pointer transition-colors ${expanded ? "bg-fob-border" : "hover:bg-fob-border/50"}`}
                  onClick={(e) => { e.stopPropagation(); setExpandedLayer(expanded ? null : layer.id); }}
                >
                  {/* Color swatch / picker */}
                  {onUpdateLayers ? (
                    <input type="color" value={layer.color}
                      onChange={(e) => { e.stopPropagation(); setLayerColor(layer.id, e.target.value); }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-3.5 w-3.5 flex-shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                      title="Layer colour" />
                  ) : (
                    <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: layer.color }} />
                  )}

                  {/* Name (or rename input) */}
                  {renamingId === layer.id ? (
                    <input ref={renameRef} defaultValue={layer.name} autoFocus
                      className="flex-1 min-w-0 bg-fob-bg border border-fob-orange rounded px-1 text-[9px] text-fob-text outline-none"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => renameLayer(layer.id, e.target.value || layer.name)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") renameLayer(layer.id, (e.target as HTMLInputElement).value || layer.name);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className={`flex-1 truncate font-mono ${hidden ? "line-through opacity-50" : ""}`}
                      onDoubleClick={(e) => { e.stopPropagation(); if (onUpdateLayers) setRenamingId(layer.id); }}
                      title="Double-click to rename"
                    >{layer.name}</span>
                  )}

                  <span className="text-fob-text-dim flex-shrink-0">({layer.items.length})</span>

                  {/* Visibility toggle */}
                  <button onClick={(e) => { e.stopPropagation(); toggleLayer(layer.id); }}
                    className="flex-shrink-0 text-fob-text-dim hover:text-fob-text transition-colors"
                    title={hidden ? "Show" : "Hide"}>
                    {hidden ? "👁" : "👁"}
                  </button>

                  {/* Delete layer */}
                  {onUpdateLayers && (
                    <button onClick={(e) => { e.stopPropagation(); deleteLayer(layer.id); }}
                      className="flex-shrink-0 text-fob-text-dim hover:text-fob-red transition-colors"
                      title="Delete layer">✕</button>
                  )}
                </div>

                {/* Expanded: items list */}
                {expanded && (
                  <div className="border-t border-fob-border bg-fob-bg px-1.5 py-1 flex flex-col gap-0.5">
                    {layer.items.length === 0 ? (
                      <span className="text-fob-text-dim italic">No items</span>
                    ) : (
                      layer.items.map((item, idx) => (
                        <div key={idx} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-fob-border group">
                          <span className="flex-1 truncate font-mono text-fob-text-dim">
                            {item.type}
                            {item.type === "text" && item.text ? ` "${item.text}"` : ""}
                            {(item.type === "ruler" || item.type === "arrow") && item.x2 != null
                              ? ` (${Math.round(Math.sqrt((item.x2 - item.x1) ** 2 + ((item.y2 ?? 0) - item.y1) ** 2))}px)`
                              : ""}
                          </span>
                          {onUpdateLayers && (
                            <button onClick={(e) => { e.stopPropagation(); deleteItem(layer.id, idx); }}
                              className="opacity-0 group-hover:opacity-100 text-fob-text-dim hover:text-fob-red transition-all"
                              title="Delete item">✕</button>
                          )}
                        </div>
                      ))
                    )}
                    {onUpdateLayers && layer.items.length > 0 && (
                      <button onClick={(e) => { e.stopPropagation(); clearLayer(layer.id); }}
                        className="mt-0.5 w-full rounded bg-fob-border px-1 py-0.5 text-fob-text-dim hover:text-fob-orange transition-colors text-center"
                        title="Clear all items">Clear all</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Fullsize button pinned to bottom */}
          <div className="mt-auto border-t border-fob-border pt-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
              className="w-full rounded bg-fob-border px-2 py-1 text-center text-fob-text-dim hover:text-fob-text hover:bg-fob-surface transition-colors"
            >
              🔍 Full size
            </button>
          </div>
        </div>
      </div>

      {lightbox && (
        <Lightbox
          src={cell.imageDataUrl}
          onClose={() => setLightbox(false)}
          layers={visibleLayers}
          imgW={imgSize?.w}
          imgH={imgSize?.h}
          uid={`lb-${cell.id}`}
        />
      )}
    </div>
  );
}

// ── Code cell ─────────────────────────────────────────────────────────────────
function CodeCellView({ cell }: { cell: CodeCell }) {
  // Check if it's annotation layers JSON
  if (cell.lang === "json" || cell.lang === "") {
    try {
      const parsed = JSON.parse(cell.code);
      if (Array.isArray(parsed) && parsed.length > 0 && "items" in parsed[0]) {
        // Already handled as part of LensCaptureCell — skip standalone render
        return null;
      }
    } catch { /* not layers */ }
  }

  return (
    <div className="my-2 overflow-hidden rounded border border-fob-border">
      {cell.lang && (
        <div className="border-b border-fob-border bg-fob-surface px-3 py-0.5 text-[9px] font-mono text-fob-text-dim uppercase tracking-wider">
          {cell.lang}
        </div>
      )}
      <pre className="overflow-x-auto bg-fob-bg p-3 font-mono text-[11px] text-fob-text">
        <code>{cell.code}</code>
      </pre>
    </div>
  );
}

// ── Main cell renderer ────────────────────────────────────────────────────────
export function NoteCellRenderer({
  cells,
  onUpdateLayers,
  onWikiLink,
  onTagClick,
  projectName,
}: {
  cells: NoteCell[];
  onUpdateLayers?: (imageDataUrl: string, layers: import("../lensforge/types").AnnotationLayer[]) => void;
  onWikiLink?: (title: string) => void;
  onTagClick?: (tag: string) => void;
  projectName?: string;
}) {
  const mdComponents = onWikiLink || onTagClick ? buildNoteMarkdownComponents(onWikiLink, onTagClick, projectName) : noteMarkdownComponents;
  return (
    <div className="flex flex-col">
      {cells.map((cell) => {
        if (cell.type === "lens-capture") return <LensCaptureCellView key={cell.id} cell={cell} onUpdateLayers={onUpdateLayers} />;
        if (cell.type === "code") return <CodeCellView key={cell.id} cell={cell} />;
        return (
          <div key={cell.id} className="py-0.5">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLinks, remarkTags]} rehypePlugins={[rehypeRaw]} components={mdComponents}>
              {cell.markdown}
            </ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}
