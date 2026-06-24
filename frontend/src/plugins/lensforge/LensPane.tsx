import { useEffect, useRef, useState, useCallback } from "react";
import {
  ZoomIn, ZoomOut, Camera, Trash2, RotateCcw, Layers, Plus, Eye, EyeOff,
  Minus, ArrowUpRight, Type, PenLine, Power, Pause, Play, RefreshCw, Settings, Info,
  FlipHorizontal2, FlipVertical2, SlidersHorizontal,
} from "lucide-react";
import { useCamera } from "./useCamera";
import { LensRingBuffer } from "./LensRingBuffer";
import { FILTER_DEFS, FILTER_MAP } from "./filterDefs";
import { CameraControls } from "./CameraControls";
import type {
  PaneConfig, AnnotationItem, AnnotationLayer, AnnotationToolType,
  FilterKey, LensSnapshot, PaneStatus, CameraConstraints, StreamSource,
  ExtendedCameraCapabilities, ExtendedCameraSettings, ExtendedCameraConstraints,
} from "./types";
import { defaultLayer } from "./types";

const RES_PRESETS = [
  { label: "320×240",  w: 320,  h: 240  },
  { label: "640×480",  w: 640,  h: 480  },
  { label: "1280×720", w: 1280, h: 720  },
  { label: "1920×1080",w: 1920, h: 1080 },
];
const FPS_PRESETS = [15, 24, 30, 60];

const LAYER_COLORS = ["#ff6b00", "#60a5fa", "#86efac", "#f87171", "#c084fc", "#fbbf24"];

interface LensPaneProps {
  config: PaneConfig;
  onChange: (patch: Partial<PaneConfig>) => void;
  onSnapshot: (snap: LensSnapshot) => void;
  onStatusChange?: (status: PaneStatus) => void;
  sharedStream?: MediaStream | null;
  onStreamReady?: (stream: MediaStream | null) => void;
  availableSources?: StreamSource[];
}

function rulerLength(ann: AnnotationItem): string {
  if (ann.x2 == null || ann.y2 == null) return "";
  const dx = ann.x2 - ann.x1;
  const dy = ann.y2 - ann.y1;
  return `${Math.round(Math.sqrt(dx * dx + dy * dy))}px`;
}

type TabKey = "layers" | "settings" | "camera" | "info";

export function LensPane({ config, onChange, onSnapshot, onStatusChange, sharedStream, onStreamReady, availableSources }: LensPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fpsRingRef = useRef(new LensRingBuffer(60));
  const rafRef = useRef<number>(0);

  const [fps, setFps] = useState(0);
  const [frozen, setFrozen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey | null>(null);

  // Settings draft state
  const [draftRes, setDraftRes] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [draftFps, setDraftFps] = useState(0);

  // --- Layer state ---
  const [layers, setLayers] = useState<AnnotationLayer[]>([defaultLayer("layer-0", "Layer 1")]);
  const [activeLayerId, setActiveLayerId] = useState("layer-0");
  const [activeTool, setActiveTool] = useState<AnnotationToolType | null>(null);

  // --- Drawing state ---
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [freehandPoints, setFreehandPoints] = useState<[number, number][]>([]);
  const [liveEnd, setLiveEnd] = useState<{ x: number; y: number } | null>(null);
  const [pendingText, setPendingText] = useState<{ x: number; y: number } | null>(null);

  // --- Pan state ---
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const isSharedMode = config.streamSource !== "own";

  const {
    stream, error, devices, activeDeviceId,
    selectDevice, stopActive, reloadStream, applyConstraints, applyCameraConstraints,
    capabilities, trackSettings,
  } = useCamera(config.deviceId, config.constraints, isSharedMode ? sharedStream : null);

  // ── Report own stream upward so LensForgeApp can share it ──
  useEffect(() => {
    if (!isSharedMode && onStreamReady) onStreamReady(stream);
  }, [isSharedMode, stream, onStreamReady]);

  // ── Power control ──
  useEffect(() => {
    if (!config.powered) {
      stopActive();
      if (videoRef.current) videoRef.current.srcObject = null;
      setFrozen(false);
    } else if (!isSharedMode) {
      reloadStream();
    }
    // shared mode: stream arrives via sharedStream prop — handled below
  }, [config.powered, isSharedMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attach stream to video ──
  // In own mode: attach when useCamera exposes the stream.
  // In shared mode: attach directly from the prop — avoids the extra
  // React state cycle in useCamera which can miss the video element.
  useEffect(() => {
    if (!videoRef.current || !config.powered) return;
    const vid = videoRef.current;
    if (isSharedMode) {
      vid.srcObject = sharedStream ?? null;
    } else if (stream) {
      vid.srcObject = stream;
    }
    // Re-fire status with real dimensions once the video element has decoded the
    // first frame — track.getSettings() may return {width:0,height:0} before this.
    const onMeta = () => {
      if (!onStatusChange) return;
      onStatusChange({
        paneId: config.id,
        state: "streaming",
        width: vid.videoWidth,
        height: vid.videoHeight,
        fps,
      });
    };
    vid.addEventListener("loadedmetadata", onMeta);
    return () => vid.removeEventListener("loadedmetadata", onMeta);
  }, [stream, sharedStream, isSharedMode, config.powered, config.id, fps, onStatusChange]);

  // ── Sync deviceId from config ──
  useEffect(() => {
    if (config.deviceId && config.deviceId !== activeDeviceId) {
      selectDevice(config.deviceId);
    }
  }, [config.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── FPS ring ──
  useEffect(() => {
    const tick = () => {
      if (videoRef.current && videoRef.current.readyState >= 2 && !videoRef.current.paused) {
        setFps(fpsRingRef.current.pushFrame());
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Status reporting ──
  useEffect(() => {
    if (!onStatusChange) return;
    const state = !config.powered ? "off"
      : error ? "error"
      : frozen ? "paused"
      : stream ? "streaming"
      : "off";
    onStatusChange({
      paneId: config.id,
      state,
      width: trackSettings?.width ?? 0,
      height: trackSettings?.height ?? 0,
      fps,
    });
  }, [config.powered, config.id, error, frozen, stream, fps, trackSettings, onStatusChange]);

  // ── Settings draft sync ──
  useEffect(() => {
    if (trackSettings) {
      setDraftRes({ w: trackSettings.width ?? 0, h: trackSettings.height ?? 0 });
      setDraftFps(trackSettings.frameRate ?? 0);
    }
  }, [trackSettings]);

  const zoom = config.zoom;
  const pan = config.pan;

  // ── Layer helpers ──
  const addItemToActiveLayer = useCallback((item: AnnotationItem) => {
    setLayers((prev) => prev.map((l) => l.id === activeLayerId ? { ...l, items: [...l.items, item] } : l));
  }, [activeLayerId]);

  const addLayer = useCallback(() => {
    const idx = layers.length;
    const id = `layer-${Date.now()}`;
    const color = LAYER_COLORS[idx % LAYER_COLORS.length];
    setLayers((prev) => [...prev, defaultLayer(id, `Layer ${idx + 1}`, color)]);
    setActiveLayerId(id);
  }, [layers.length]);

  const deleteLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const next = prev.filter((l) => l.id !== id);
      if (next.length === 0) { setActiveLayerId("layer-0"); return [defaultLayer("layer-0", "Layer 1")]; }
      setActiveLayerId(next[next.length - 1].id);
      return next;
    });
  }, []);

  const toggleLayerVisible = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => l.id === id ? { ...l, visible: !l.visible } : l));
  }, []);

  const clearLayer = useCallback((id: string) => {
    setLayers((prev) => prev.map((l) => l.id === id ? { ...l, items: [] } : l));
  }, []);

  const setLayerColor = useCallback((id: string, color: string) => {
    setLayers((prev) => prev.map((l) => l.id === id ? { ...l, color } : l));
  }, []);

  const setLayerStrokeWidth = useCallback((id: string, strokeWidth: number) => {
    setLayers((prev) => prev.map((l) => l.id === id ? { ...l, strokeWidth } : l));
  }, []);

  // ── Interaction ──
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    onChange({ zoom: Math.min(Math.max(zoom + (e.deltaY > 0 ? -0.15 : 0.15), 1), 5) });
  }, [zoom, onChange]);

  const getRelPos = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!activeTool) { setDragging(true); dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; return; }
    const pos = getRelPos(e);
    if (activeTool === "text") { setPendingText(pos); return; }
    if (activeTool === "freehand") { setFreehandPoints([[pos.x, pos.y]]); setDrawStart(pos); return; }
    setDrawStart(pos); setLiveEnd(pos);
  }, [activeTool, pan]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!activeTool && dragging) { onChange({ pan: { x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y } }); return; }
    if (!drawStart) return;
    const pos = getRelPos(e);
    if (activeTool === "freehand") setFreehandPoints((prev) => [...prev, [pos.x, pos.y]]);
    else setLiveEnd(pos);
  }, [activeTool, dragging, drawStart, onChange]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!activeTool) { setDragging(false); return; }
    const pos = getRelPos(e);
    const color = layers.find((l) => l.id === activeLayerId)?.color ?? "#ff6b00";
    const strokeWidth = layers.find((l) => l.id === activeLayerId)?.strokeWidth ?? 2;
    if (activeTool === "freehand" && freehandPoints.length > 1) {
      addItemToActiveLayer({ type: "freehand", x1: freehandPoints[0][0], y1: freehandPoints[0][1], points: [...freehandPoints], color, strokeWidth });
      setFreehandPoints([]);
    } else if (drawStart && (activeTool === "ruler" || activeTool === "arrow")) {
      if (Math.abs(pos.x - drawStart.x) > 4 || Math.abs(pos.y - drawStart.y) > 4)
        addItemToActiveLayer({ type: activeTool, x1: drawStart.x, y1: drawStart.y, x2: pos.x, y2: pos.y, color, strokeWidth });
    }
    setDrawStart(null); setLiveEnd(null);
  }, [activeTool, drawStart, freehandPoints, layers, activeLayerId, addItemToActiveLayer]);

  const commitText = useCallback((text: string) => {
    if (!pendingText || !text.trim()) { setPendingText(null); return; }
    const color = layers.find((l) => l.id === activeLayerId)?.color ?? "#ff6b00";
    const strokeWidth = layers.find((l) => l.id === activeLayerId)?.strokeWidth ?? 2;
    addItemToActiveLayer({ type: "text", x1: pendingText.x, y1: pendingText.y, text, color, strokeWidth });
    setPendingText(null);
  }, [pendingText, layers, activeLayerId, addItemToActiveLayer]);

  // ── Snapshot ──
  const takeSnapshot = useCallback(async () => {
    const video = videoRef.current; const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const cssF = FILTER_MAP[config.filter].css;
    ctx.filter = cssF === "none" ? "" : cssF;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (config.flipH) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    if (config.flipV) { ctx.translate(0, canvas.height); ctx.scale(1, -1); }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.filter = "";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => onSnapshot({ paneId: config.id, timestamp: Date.now(), imageDataUrl: reader.result as string, layers, filter: config.filter, label: config.label });
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.9);
  }, [config, layers, onSnapshot]);

  // ── Settings apply ──
  const applySettings = useCallback(async () => {
    const newC: CameraConstraints = { width: draftRes.w, height: draftRes.h, frameRate: draftFps };
    await applyConstraints(newC);
    onChange({ constraints: newC });
  }, [draftRes, draftFps, applyConstraints, onChange]);

  // ── Quick camera auto/manual toggles ──
  const cap = capabilities as ExtendedCameraCapabilities | null;
  const setts = trackSettings as ExtendedCameraSettings | null;

  const toggleAF = useCallback(async () => {
    if (!cap?.focusMode) return;
    const isAuto = setts?.focusMode === "continuous" || setts?.focusMode === "single-shot";
    const next = isAuto ? "manual" : cap.focusMode.includes("continuous") ? "continuous" : cap.focusMode.includes("single-shot") ? "single-shot" : cap.focusMode[0];
    await applyCameraConstraints({ focusMode: next } as ExtendedCameraConstraints);
  }, [cap, setts, applyCameraConstraints]);

  const toggleAE = useCallback(async () => {
    if (!cap?.exposureMode) return;
    const isAuto = setts?.exposureMode === "auto";
    const next = isAuto ? "manual" : cap.exposureMode.includes("auto") ? "auto" : cap.exposureMode[0];
    await applyCameraConstraints({ exposureMode: next } as ExtendedCameraConstraints);
  }, [cap, setts, applyCameraConstraints]);

  const toggleAWB = useCallback(async () => {
    if (!cap?.whiteBalanceMode) return;
    const isAuto = setts?.whiteBalanceMode === "auto";
    const next = isAuto ? "manual" : cap.whiteBalanceMode.includes("auto") ? "auto" : cap.whiteBalanceMode[0];
    await applyCameraConstraints({ whiteBalanceMode: next } as ExtendedCameraConstraints);
  }, [cap, setts, applyCameraConstraints]);

  const cssFilter = FILTER_MAP[config.filter].css;
  const annotating = activeTool !== null;
  const activeLayerColor = layers.find((l) => l.id === activeLayerId)?.color ?? "#ff6b00";

  // Filter presets by capabilities
  const validPresets = capabilities
    ? RES_PRESETS.filter((p) => {
        const cw = capabilities.width as { max?: number } | undefined;
        const ch = capabilities.height as { max?: number } | undefined;
        return (!cw?.max || cw.max >= p.w) && (!ch?.max || ch.max >= p.h);
      })
    : RES_PRESETS;
  const validFps = capabilities
    ? FPS_PRESETS.filter((f) => {
        const cf = capabilities.frameRate as { max?: number } | undefined;
        return !cf?.max || cf.max >= f;
      })
    : FPS_PRESETS;

  const TOOLS: { key: AnnotationToolType; icon: React.ReactNode; title: string }[] = [
    { key: "ruler",    icon: <Minus size={16} />,        title: "Ruler" },
    { key: "arrow",    icon: <ArrowUpRight size={16} />, title: "Arrow" },
    { key: "freehand", icon: <PenLine size={16} />,      title: "Freehand" },
    { key: "text",     icon: <Type size={16} />,         title: "Text" },
  ];

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded border border-fob-border bg-fob-surface">

      {/* ── Top bar ── */}
      <div 
        className="flex items-center gap-1.5 bg-fob-surface px-2"
        style={{
          height: 'var(--fob-plugin-bar-height, 48px)',
        }}
      >
        {/* Left: Power button */}
        <button
          onClick={() => onChange({ powered: !config.powered })}
          className={`w-6 h-6 rounded-full flex items-center justify-center border-2 transition-all ${
            config.powered
              ? "bg-fob-green border-fob-green text-fob-accent-text"
              : "bg-fob-surface border-fob-border text-fob-text-dim"
          }`}
          title={config.powered ? "Turn off camera" : "Turn on camera"}
        >
          {config.powered ? "⏻" : "⏻"}
        </button>
        
        {/* Camera selector */}
        <select
          value={config.deviceId}
          onChange={(e) => onChange({ deviceId: e.target.value })}
          className="rounded bg-fob-bg px-1 py-0.5 text-[10px] text-fob-text outline-none"
          disabled={!config.powered}
        >
          {devices.length === 0 && <option value="">No cameras</option>}
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
        
        {/* FPS display */}
        <span className="text-[9px] font-mono text-fob-text-dim">{fps}fps</span>
        
        {/* Pane label */}
        <span className="truncate text-[11px] font-bold uppercase tracking-wider text-fob-orange" style={{ flex: "0 1 auto", minWidth: 0 }}>
          {config.label}
        </span>
        
        <div className="flex-1" />
        
        {/* Right side controls */}
        <select
          value={config.filter}
          onChange={(e) => onChange({ filter: e.target.value as FilterKey })}
          className="rounded bg-fob-bg px-1.5 py-1 text-[11px] text-fob-text outline-none"
        >
          {FILTER_DEFS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <button onClick={() => onChange({ zoom: Math.min(zoom + 0.25, 5) })} className="rounded p-1 text-fob-text-dim hover:text-fob-text" title="Zoom in"><ZoomIn size={15} /></button>
        <button onClick={() => onChange({ zoom: Math.max(zoom - 0.25, 1) })} className="rounded p-1 text-fob-text-dim hover:text-fob-text" title="Zoom out"><ZoomOut size={15} /></button>
        <button onClick={() => onChange({ zoom: 1, pan: { x: 0, y: 0 } })} className="rounded p-1 text-fob-text-dim hover:text-fob-text" title="Reset view"><RotateCcw size={15} /></button>
      </div>

      {/* ── Action bar ── */}
      <div className="flex items-center gap-2 border-b border-fob-border bg-fob-bg px-2 py-2 flex-wrap">
        {/* Annotation tools */}
        {TOOLS.map((t) => (
          <button key={t.key}
            onClick={() => setActiveTool((prev) => prev === t.key ? null : t.key)}
            disabled={!config.powered}
            title={t.title}
            className={`flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-30 ${
              activeTool === t.key ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface text-fob-text-dim hover:text-fob-text hover:bg-fob-border"
            }`}
          >
            {t.icon}<span className="hidden sm:inline">{t.title}</span>
          </button>
        ))}
        {activeTool && (
          <button onClick={() => setActiveTool(null)} className="rounded px-2.5 py-1.5 text-xs text-fob-text-dim hover:text-fob-red">✕</button>
        )}
        <div className="mx-1 h-5 w-px bg-fob-border" />
        {/* Freeze/Resume */}
        <button
          onClick={() => { if (!frozen) { videoRef.current?.pause(); setFrozen(true); } else { videoRef.current?.play(); setFrozen(false); } }}
          disabled={!config.powered || !stream}
          title={frozen ? "Resume" : "Freeze frame"}
          className={`flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-30 ${
            frozen ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface text-fob-text-dim hover:text-fob-text hover:bg-fob-border"
          }`}
        >
          {frozen ? <Play size={16} /> : <Pause size={16} />}
        </button>
        {/* Flip H/V */}
        <button onClick={() => onChange({ flipH: !config.flipH })} title="Flip horizontal"
          className={`rounded p-1.5 transition-colors ${config.flipH ? "text-fob-orange bg-fob-surface" : "text-fob-text-dim hover:text-fob-text hover:bg-fob-surface"}`}>
          <FlipHorizontal2 size={16} />
        </button>
        <button onClick={() => onChange({ flipV: !config.flipV })} title="Flip vertical"
          className={`rounded p-1.5 transition-colors ${config.flipV ? "text-fob-orange bg-fob-surface" : "text-fob-text-dim hover:text-fob-text hover:bg-fob-surface"}`}>
          <FlipVertical2 size={16} />
        </button>
        <div className="mx-1 h-5 w-px bg-fob-border" />
        {/* Reload + Power */}
        <button onClick={reloadStream} disabled={!config.powered} title="Reload camera"
          className="rounded p-1.5 text-fob-text-dim hover:text-fob-text hover:bg-fob-surface disabled:opacity-30">
          <RefreshCw size={16} />
        </button>
        <button
          onClick={() => onChange({ powered: !config.powered })}
          title={config.powered ? "Power off" : "Power on"}
          className={`rounded p-1.5 transition-colors ${config.powered ? "text-fob-green hover:text-fob-red hover:bg-fob-surface" : "text-fob-text-dim hover:text-fob-green hover:bg-fob-surface"}`}
        >
          <Power size={16} />
        </button>
        {(cap?.focusMode || cap?.exposureMode || cap?.whiteBalanceMode) && (
          <>
            <div className="mx-1 h-5 w-px bg-fob-border" />
            <div className="flex items-center gap-1">
              {cap?.focusMode && (
                <button
                  onClick={toggleAF}
                  disabled={!config.powered || !stream || isSharedMode}
                  title={setts?.focusMode === "manual" ? "Auto focus (AF) off" : "Auto focus (AF) on"}
                  className={`rounded px-2 py-1 text-[10px] font-bold transition-colors disabled:opacity-30 ${
                    setts?.focusMode === "manual" || setts?.focusMode === undefined
                      ? "bg-fob-surface text-fob-text-dim hover:text-fob-text"
                      : "bg-fob-orange text-fob-accent-text"
                  }`}
                >
                  AF
                </button>
              )}
              {cap?.exposureMode && (
                <button
                  onClick={toggleAE}
                  disabled={!config.powered || !stream || isSharedMode}
                  title={setts?.exposureMode === "manual" ? "Auto exposure (AE) off" : "Auto exposure (AE) on"}
                  className={`rounded px-2 py-1 text-[10px] font-bold transition-colors disabled:opacity-30 ${
                    setts?.exposureMode === "manual" || setts?.exposureMode === undefined
                      ? "bg-fob-surface text-fob-text-dim hover:text-fob-text"
                      : "bg-fob-orange text-fob-accent-text"
                  }`}
                >
                  AE
                </button>
              )}
              {cap?.whiteBalanceMode && (
                <button
                  onClick={toggleAWB}
                  disabled={!config.powered || !stream || isSharedMode}
                  title={setts?.whiteBalanceMode === "manual" ? "Auto white balance (AWB) off" : "Auto white balance (AWB) on"}
                  className={`rounded px-2 py-1 text-[10px] font-bold transition-colors disabled:opacity-30 ${
                    setts?.whiteBalanceMode === "manual" || setts?.whiteBalanceMode === undefined
                      ? "bg-fob-surface text-fob-text-dim hover:text-fob-text"
                      : "bg-fob-orange text-fob-accent-text"
                  }`}
                >
                  AWB
                </button>
              )}
            </div>
          </>
        )}
        <div className="flex-1" />
        {/* Save */}
        <button
          onClick={takeSnapshot}
          disabled={!config.powered || !stream}
          title="Save snapshot to Notes"
          className="flex items-center gap-1.5 rounded-lg bg-fob-orange px-4 py-2 text-sm font-bold text-fob-accent-text shadow hover:opacity-90 active:scale-95 transition-all disabled:opacity-30"
        >
          <Camera size={16} />Save
        </button>
      </div>

      {/* ── Video viewport ── */}
      <div
        className={`relative flex-1 overflow-hidden ${annotating ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
        onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
        onMouseLeave={() => { setDragging(false); setDrawStart(null); setLiveEnd(null); setFreehandPoints([]); }}
      >
        {!config.powered ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Power size={28} className="text-fob-text-dim opacity-40" />
            <span className="text-xs text-fob-text-dim">Camera off</span>
            <button onClick={() => onChange({ powered: true })} className="rounded bg-fob-border px-3 py-1 text-xs text-fob-green hover:opacity-90">Power on</button>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center bg-fob-surface">
            <span className="text-xs text-fob-red">{error}</span>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover bg-fob-surface"
              style={{ transform: [`translate(${pan.x}px, ${pan.y}px)`, `scale(${zoom})`, config.flipH ? "scaleX(-1)" : "", config.flipV ? "scaleY(-1)" : ""].filter(Boolean).join(" "), transformOrigin: "center center", filter: cssFilter === "none" ? undefined : cssFilter }}
            />
            <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full">
              <defs>
                {layers.map((l) => (
                  <marker key={l.id} id={`arrowhead-${l.id}`} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <polygon points="0 0, 8 3, 0 6" fill={l.color} />
                  </marker>
                ))}
              </defs>
              {layers.filter((l) => l.visible).map((layer) =>
                layer.items.map((ann, i) => (
                  <g key={`${layer.id}-${i}`}>
                    {(ann.type === "ruler" || ann.type === "arrow") && ann.x2 != null && ann.y2 != null && (
                      <>
                        <line x1={ann.x1} y1={ann.y1} x2={ann.x2} y2={ann.y2}
                          stroke={ann.color} strokeWidth={ann.strokeWidth ?? 1.5}
                          strokeDasharray={ann.type === "ruler" ? "4 2" : undefined}
                          markerEnd={ann.type === "arrow" ? `url(#arrowhead-${layer.id})` : undefined}
                        />
                        {ann.type === "ruler" && <>
                          <circle cx={ann.x1} cy={ann.y1} r={3} fill={ann.color} />
                          <circle cx={ann.x2} cy={ann.y2} r={3} fill={ann.color} />
                          <text x={(ann.x1+ann.x2)/2} y={(ann.y1+ann.y2)/2-4} fill={ann.color} fontSize={10} fontFamily="monospace" textAnchor="middle">{rulerLength(ann)}</text>
                        </>}
                      </>
                    )}
                    {ann.type === "freehand" && ann.points && ann.points.length > 1 && (
                      <polyline points={ann.points.map(([x,y])=>`${x},${y}`).join(" ")} stroke={ann.color} strokeWidth={ann.strokeWidth ?? 1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                    )}
                    {ann.type === "text" && ann.text && (
                      <text x={ann.x1} y={ann.y1} fill={ann.color} fontSize={ann.strokeWidth ? 10 + ann.strokeWidth * 2 : 13} fontFamily="monospace" stroke="black" strokeWidth={0.5} paintOrder="stroke">{ann.text}</text>
                    )}
                  </g>
                ))
              )}
              {drawStart && liveEnd && (activeTool === "ruler" || activeTool === "arrow") && (
                <line x1={drawStart.x} y1={drawStart.y} x2={liveEnd.x} y2={liveEnd.y} stroke={activeLayerColor} strokeWidth={1.5} strokeDasharray="4 2" opacity={0.6} />
              )}
              {activeTool === "freehand" && freehandPoints.length > 1 && (
                <polyline points={freehandPoints.map(([x,y])=>`${x},${y}`).join(" ")} stroke={activeLayerColor} strokeWidth={1.5} fill="none" opacity={0.6} />
              )}
            </svg>
            {pendingText && (
              <form style={{ position: "absolute", left: pendingText.x, top: pendingText.y, zIndex: 50 }}
                onSubmit={(e) => { e.preventDefault(); commitText((e.currentTarget.elements.namedItem("t") as HTMLInputElement).value); }}>
                <input name="t" autoFocus placeholder="Label…"
                  onBlur={(e) => commitText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setPendingText(null); }}
                  className="rounded border border-fob-orange bg-black/80 px-2 py-1 text-xs text-fob-orange outline-none"
                />
              </form>
            )}
          </>
        )}
      </div>

      {/* ── Bottom tab bar ── */}
      <div className="border-t border-fob-border bg-fob-surface">
        {/* Tab headers */}
        <div className="flex items-center">
          {(["layers", "settings", "camera", "info"] as TabKey[]).map((tab) => (
            <button key={tab}
              onClick={() => setActiveTab((prev) => prev === tab ? null : tab)}
              className={`flex items-center gap-1 px-3 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors border-b-2 ${
                activeTab === tab ? "border-fob-orange text-fob-orange" : "border-transparent text-fob-text-dim hover:text-fob-text"
              }`}
            >
              {tab === "layers" && <Layers size={10} />}
              {tab === "settings" && <Settings size={10} />}
              {tab === "camera" && <SlidersHorizontal size={10} />}
              {tab === "info" && <Info size={10} />}
              {tab}
            </button>
          ))}
          <div className="flex-1" />
          <span className="mr-2 text-[9px] font-mono text-fob-text-dim">{Math.round(zoom * 100)}%</span>
        </div>

        {/* Tab content */}
        {activeTab === "layers" && (
          <div className="px-2 py-1.5 border-t border-fob-border">
            <div className="mb-1 flex items-center gap-1">
              <span className="flex-1 text-[10px] font-bold uppercase tracking-wider text-fob-orange">Layers</span>
              <button onClick={addLayer} className="flex items-center gap-0.5 rounded bg-fob-border px-1.5 py-0.5 text-[10px] text-fob-text-dim hover:text-fob-text"><Plus size={10} /> Add</button>
            </div>
            <div className="flex flex-col gap-0.5 max-h-24 overflow-y-auto">
              {layers.map((layer) => (
                <div key={layer.id}
                  className={`flex flex-col rounded px-1.5 py-0.5 cursor-pointer text-[10px] transition-colors ${activeLayerId === layer.id ? "bg-fob-border" : "hover:bg-fob-bg"}`}
                  onClick={() => setActiveLayerId(layer.id)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: layer.color }} />
                    <span className="flex-1 truncate font-mono text-fob-text">{layer.name}</span>
                    <span className="text-fob-text-dim">{layer.items.length}</span>
                    <button onClick={(e) => { e.stopPropagation(); toggleLayerVisible(layer.id); }} className="text-fob-text-dim hover:text-fob-text">
                      {layer.visible ? <Eye size={10} /> : <EyeOff size={10} />}
                    </button>
                    {layer.items.length > 0 && (
                      <button onClick={(e) => { e.stopPropagation(); clearLayer(layer.id); }} className="text-fob-text-dim hover:text-fob-orange" title="Clear"><Minus size={10} /></button>
                    )}
                    {layers.length > 1 && (
                      <button onClick={(e) => { e.stopPropagation(); deleteLayer(layer.id); }} className="text-fob-text-dim hover:text-fob-red" title="Delete"><Trash2 size={10} /></button>
                    )}
                  </div>
                  {activeLayerId === layer.id && (
                    <div className="flex items-center gap-2 mt-1 pl-4" onClick={(e) => e.stopPropagation()}>
                      <label className="text-[9px] text-fob-text-dim">Color</label>
                      <input type="color" value={layer.color}
                        onChange={(e) => setLayerColor(layer.id, e.target.value)}
                        className="h-4 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                        title="Layer colour" />
                      <label className="text-[9px] text-fob-text-dim ml-1">Width</label>
                      {[1, 2, 3, 5, 8].map((w) => (
                        <button key={w} onClick={() => setLayerStrokeWidth(layer.id, w)}
                          className={`rounded px-1 py-0.5 text-[9px] font-mono transition-colors ${
                            (layer.strokeWidth ?? 2) === w ? "bg-fob-orange text-fob-accent-text font-bold" : "bg-fob-bg text-fob-text-dim hover:text-fob-text"
                          }`}
                        >{w}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "settings" && (
          <div className="px-2 py-1.5 border-t border-fob-border space-y-1.5">
            {/* Stream source */}
            {availableSources && availableSources.length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] text-fob-text-dim">Source:</span>
                {availableSources.map((src) => (
                  <button
                    key={src}
                    onClick={() => onChange({ streamSource: src })}
                    className={`rounded px-2 py-0.5 text-[9px] font-bold transition-colors ${
                      config.streamSource === src
                        ? "bg-fob-orange text-fob-accent-text"
                        : "bg-fob-border text-fob-text-dim hover:text-fob-text"
                    }`}
                  >
                    {src === "own" ? "Own" : `Share ${src}`}
                  </button>
                ))}
                {isSharedMode && (
                  <span className="text-[9px] text-fob-orange font-mono">cloned — 0 extra CPU</span>
                )}
              </div>
            )}
            {/* Quick presets */}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[9px] text-fob-text-dim mr-0.5">Quick:</span>
              {[
                { label: "RPi 240p", w: 320,  h: 240,  fps: 15 },
                { label: "SD 480p",  w: 640,  h: 480,  fps: 24 },
                { label: "HD 720p",  w: 1280, h: 720,  fps: 30 },
                { label: "FHD",      w: 1920, h: 1080, fps: 30 },
              ].map((q) => {
                const active = draftRes.w === q.w && draftRes.h === q.h && draftFps === q.fps;
                return (
                  <button
                    key={q.label}
                    onClick={async () => {
                      const newC: CameraConstraints = { width: q.w, height: q.h, frameRate: q.fps };
                      setDraftRes({ w: q.w, h: q.h });
                      setDraftFps(q.fps);
                      await applyConstraints(newC);
                      onChange({ constraints: newC });
                    }}
                    className={`rounded px-2 py-0.5 text-[9px] font-bold transition-colors ${
                      active ? "bg-fob-orange text-fob-accent-text" : "bg-fob-border text-fob-text-dim hover:text-fob-text"
                    }`}
                  >
                    {q.label}
                  </button>
                );
              })}
            </div>
            {/* Fine-grained controls */}
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <label className="text-fob-text-dim">Resolution</label>
              <select
                value={`${draftRes.w}x${draftRes.h}`}
                onChange={(e) => { const [w, h] = e.target.value.split("x").map(Number); setDraftRes({ w, h }); }}
                className="rounded bg-fob-bg px-1 py-0.5 text-fob-text outline-none"
              >
                {validPresets.map((p) => <option key={p.label} value={`${p.w}x${p.h}`}>{p.label}</option>)}
              </select>
              <label className="text-fob-text-dim">FPS</label>
              <select
                value={draftFps}
                onChange={(e) => setDraftFps(Number(e.target.value))}
                className="rounded bg-fob-bg px-1 py-0.5 text-fob-text outline-none"
              >
                <option value={0}>Auto</option>
                {validFps.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <button onClick={applySettings} className="rounded bg-fob-orange px-2 py-0.5 text-[10px] font-bold text-fob-accent-text hover:opacity-90">Apply</button>
              <button onClick={() => { setDraftRes({ w: 0, h: 0 }); setDraftFps(0); onChange({ constraints: { width: 0, height: 0, frameRate: 0 } }); void applyConstraints({}); }}
                className="rounded bg-fob-border px-2 py-0.5 text-[10px] text-fob-text-dim hover:text-fob-text">Reset</button>
            </div>
          </div>
        )}

        {activeTab === "camera" && (
          <div className="border-t border-fob-border max-h-40 overflow-y-auto">
            {isSharedMode ? (
              <div className="px-2 py-1.5 text-[10px] font-mono text-fob-text-dim">
                Camera controls are disabled in shared/clone mode. Switch this pane to its own source to adjust controls.
              </div>
            ) : (
              <CameraControls
                deviceId={activeDeviceId}
                capabilities={capabilities}
                settings={trackSettings}
                onChange={applyCameraConstraints}
                disabled={!config.powered || !stream}
              />
            )}
          </div>
        )}

        {activeTab === "info" && (
          <div className="px-2 py-1.5 border-t border-fob-border font-mono text-[10px] text-fob-text-dim space-y-0.5">
            <div><span className="text-fob-text-dim">Actual: </span><span className="text-fob-text">{trackSettings?.width ?? "–"}×{trackSettings?.height ?? "–"} @ {trackSettings?.frameRate?.toFixed(1) ?? "–"} fps</span></div>
            <div><span className="text-fob-text-dim">State: </span><span className={stream ? "text-fob-green" : "text-fob-red"}>{!config.powered ? "off" : frozen ? "frozen" : stream ? "streaming" : error ? "error" : "idle"}</span></div>
            <div><span className="text-fob-text-dim">Device: </span><span className="text-fob-text truncate block">{devices.find(d => d.deviceId === activeDeviceId)?.label ?? "–"}</span></div>
            <div><span className="text-fob-text-dim">ID: </span><span className="text-fob-text opacity-60">{activeDeviceId.slice(0, 24)}…</span></div>
          </div>
        )}
      </div>

      {/* Hidden canvas */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
