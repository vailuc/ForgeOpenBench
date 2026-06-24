export type FilterKey = "orig" | "edge" | "inv" | "bw" | "sharp";

export type LayoutCount = 1 | 2 | 3;

export interface CameraConstraints {
  width: number;
  height: number;
  frameRate: number;
}

// Extended UVC capabilities not included in TypeScript's DOM lib.
export interface ExtendedCameraCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number; step?: number };
  exposureMode?: string[];
  exposureTime?: { min?: number; max?: number; step?: number };
  exposureCompensation?: { min?: number; max?: number; step?: number };
  whiteBalanceMode?: string[];
  colorTemperature?: { min?: number; max?: number; step?: number };
  zoom?: { min?: number; max?: number; step?: number };
  brightness?: { min?: number; max?: number; step?: number };
  contrast?: { min?: number; max?: number; step?: number };
}

export interface ExtendedCameraSettings extends MediaTrackSettings {
  focusMode?: string;
  focusDistance?: number;
  exposureMode?: string;
  exposureTime?: number;
  exposureCompensation?: number;
  whiteBalanceMode?: string;
  colorTemperature?: number;
  zoom?: number;
  brightness?: number;
  contrast?: number;
}

export interface ExtendedCameraConstraints extends MediaTrackConstraints {
  focusMode?: string;
  focusDistance?: number;
  exposureMode?: string;
  exposureTime?: number;
  exposureCompensation?: number;
  whiteBalanceMode?: string;
  colorTemperature?: number;
  zoom?: number;
  brightness?: number;
  contrast?: number;
}

export type StreamSource = "own" | "pane-0" | "pane-1" | "pane-2";

export interface PaneConfig {
  id: string;
  deviceId: string;
  filter: FilterKey;
  zoom: number;
  pan: { x: number; y: number };
  label: string;
  powered: boolean;
  constraints: CameraConstraints;
  streamSource: StreamSource;
  flipH: boolean;
  flipV: boolean;
}

export type PaneStatusState = "streaming" | "paused" | "off" | "error";

export interface PaneStatus {
  paneId: string;
  state: PaneStatusState;
  width: number;
  height: number;
  fps: number;
}

export type AnnotationToolType = "ruler" | "freehand" | "text" | "arrow";

export interface AnnotationItem {
  type: AnnotationToolType;
  x1: number;
  y1: number;
  x2?: number;
  y2?: number;
  points?: [number, number][];
  text?: string;
  color: string;
  strokeWidth?: number;
}

export interface AnnotationLayer {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  strokeWidth: number;
  items: AnnotationItem[];
}

export interface LensSnapshot {
  paneId: string;
  timestamp: number;
  imageDataUrl: string;
  layers: AnnotationLayer[];
  filter: FilterKey;
  label: string;
}

export function defaultLayer(id: string, name: string, color = "#ff6b00"): AnnotationLayer {
  return { id, name, visible: true, color, strokeWidth: 2, items: [] };
}

export function defaultPane(id: string, defaultDeviceId = ""): PaneConfig {
  return {
    id,
    deviceId: defaultDeviceId,
    filter: "orig",
    zoom: 1,
    pan: { x: 0, y: 0 },
    label: id,
    powered: id === "pane-0",
    constraints: { width: 0, height: 0, frameRate: 0 },
    streamSource: id === "pane-0" ? "own" : "pane-0",
    flipH: false,
    flipV: false,
  };
}
