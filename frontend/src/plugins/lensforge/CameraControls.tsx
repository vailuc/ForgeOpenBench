import { useEffect, useMemo, useState } from "react";
import type { ExtendedCameraCapabilities, ExtendedCameraSettings } from "./types";

interface ExtendedConstraints extends MediaTrackConstraints {
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

interface CameraControlState {
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

function storageKey(deviceId: string) {
  return `lensforge-camera-controls-${deviceId || "default"}`;
}

function loadSaved(deviceId: string): CameraControlState | null {
  try {
    const raw = localStorage.getItem(storageKey(deviceId));
    if (raw) return JSON.parse(raw) as CameraControlState;
  } catch { /* ignore */ }
  return null;
}

function saveState(deviceId: string, state: CameraControlState) {
  try {
    localStorage.setItem(storageKey(deviceId), JSON.stringify(state));
  } catch { /* ignore */ }
}

interface CameraControlsProps {
  deviceId: string;
  capabilities: MediaTrackCapabilities | null;
  settings: MediaTrackSettings | null;
  onChange: (constraints: MediaTrackConstraints) => void;
  disabled?: boolean;
}

export function CameraControls({ deviceId, capabilities, settings, onChange, disabled }: CameraControlsProps) {
  const [state, setState] = useState<CameraControlState>({});

  // Load saved settings when device changes
  useEffect(() => {
    if (!deviceId) return;
    const saved = loadSaved(deviceId);
    if (saved) {
      setState(saved);
      onChange(buildConstraints(saved));
    } else {
      setState({});
    }
  }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update state when track settings change (so UI reflects external/auto changes)
  useEffect(() => {
    if (!settings) return;
    const s = settings as ExtendedCameraSettings;
    setState((prev) => ({
      ...prev,
      focusMode: s.focusMode ?? prev.focusMode,
      focusDistance: s.focusDistance ?? prev.focusDistance,
      exposureMode: s.exposureMode ?? prev.exposureMode,
      exposureTime: s.exposureTime ?? prev.exposureTime,
      exposureCompensation: s.exposureCompensation ?? prev.exposureCompensation,
      whiteBalanceMode: s.whiteBalanceMode ?? prev.whiteBalanceMode,
      colorTemperature: s.colorTemperature ?? prev.colorTemperature,
      zoom: s.zoom ?? prev.zoom,
      brightness: s.brightness ?? prev.brightness,
      contrast: s.contrast ?? prev.contrast,
    }));
  }, [settings]);

  const update = (patch: Partial<CameraControlState>) => {
    const next = { ...state, ...patch };
    setState(next);
    saveState(deviceId, next);
    onChange(buildConstraints(next));
  };

  const cap = capabilities as ExtendedCameraCapabilities | null;
  const setts = settings as ExtendedCameraSettings | null;

  const hasAny = useMemo(() => !!cap && (
    !!cap.focusMode || !!cap.exposureMode || !!cap.whiteBalanceMode ||
    !!cap.focusDistance || !!cap.exposureTime || !!cap.exposureCompensation ||
    !!cap.colorTemperature || !!cap.zoom || !!cap.brightness || !!cap.contrast
  ), [cap]);

  if (!hasAny) {
    return (
      <div className="px-2 py-1.5 text-[10px] font-mono text-fob-text-dim">
        No camera capability controls available for this device.
      </div>
    );
  }

  return (
    <div className={`space-y-2 px-2 py-1.5 ${disabled ? "opacity-50" : ""}`}>
      {/* Focus / AF toggle */}
      {cap?.focusMode && (
        <ControlGroup label="Focus">
          <AFToggle
            modes={cap.focusMode as string[]}
            value={state.focusMode ?? setts?.focusMode ?? (cap.focusMode as string[])[0]}
            onChange={(mode) => update({ focusMode: mode })}
            disabled={disabled}
          />
          {(state.focusMode === "manual" || (!state.focusMode && setts?.focusMode === "manual")) && cap?.focusDistance && (
            <RangeControl
              cap={cap.focusDistance as { min?: number; max?: number; step?: number }}
              value={state.focusDistance ?? setts?.focusDistance ?? (cap.focusDistance as { min?: number }).min ?? 0}
              onChange={(v) => update({ focusDistance: v })}
              disabled={disabled}
              label="Distance"
            />
          )}
        </ControlGroup>
      )}

      {/* Exposure */}
      {cap?.exposureMode && (
        <ControlGroup label="Exposure">
          <ModeToggle
            modes={cap.exposureMode as string[]}
            value={state.exposureMode ?? setts?.exposureMode ?? (cap.exposureMode as string[])[0]}
            onChange={(mode) => update({ exposureMode: mode })}
            disabled={disabled}
          />
          {(state.exposureMode === "manual" || (!state.exposureMode && setts?.exposureMode === "manual")) && (
            <>
              {cap?.exposureTime && (
                <RangeControl
                  cap={cap.exposureTime as { min?: number; max?: number; step?: number }}
                  value={state.exposureTime ?? setts?.exposureTime ?? (cap.exposureTime as { min?: number }).min ?? 0}
                  onChange={(v) => update({ exposureTime: v })}
                  disabled={disabled}
                  label="Time"
                />
              )}
              {cap?.exposureCompensation && (
                <RangeControl
                  cap={cap.exposureCompensation as { min?: number; max?: number; step?: number }}
                  value={state.exposureCompensation ?? setts?.exposureCompensation ?? 0}
                  onChange={(v) => update({ exposureCompensation: v })}
                  disabled={disabled}
                  label="Compensation"
                />
              )}
            </>
          )}
        </ControlGroup>
      )}

      {/* White balance */}
      {cap?.whiteBalanceMode && (
        <ControlGroup label="White Balance">
          <ModeToggle
            modes={cap.whiteBalanceMode as string[]}
            value={state.whiteBalanceMode ?? setts?.whiteBalanceMode ?? (cap.whiteBalanceMode as string[])[0]}
            onChange={(mode) => update({ whiteBalanceMode: mode })}
            disabled={disabled}
          />
          {(state.whiteBalanceMode === "manual" || (!state.whiteBalanceMode && setts?.whiteBalanceMode === "manual")) && cap?.colorTemperature && (
            <RangeControl
              cap={cap.colorTemperature as { min?: number; max?: number; step?: number }}
              value={state.colorTemperature ?? setts?.colorTemperature ?? (cap.colorTemperature as { min?: number }).min ?? 4000}
              onChange={(v) => update({ colorTemperature: v })}
              disabled={disabled}
              label="Color Temp"
            />
          )}
        </ControlGroup>
      )}

      {/* Zoom */}
      {cap?.zoom && (
        <ControlGroup label="Zoom">
          <RangeControl
            cap={cap.zoom as { min?: number; max?: number; step?: number }}
            value={state.zoom ?? setts?.zoom ?? (cap.zoom as { min?: number }).min ?? 1}
            onChange={(v) => update({ zoom: v })}
            disabled={disabled}
            label="Zoom"
          />
        </ControlGroup>
      )}

      {/* Brightness / Contrast */}
      {(cap?.brightness || cap?.contrast) && (
        <ControlGroup label="Image">
          {cap?.brightness && (
            <RangeControl
              cap={cap.brightness as { min?: number; max?: number; step?: number }}
              value={state.brightness ?? setts?.brightness ?? 0}
              onChange={(v) => update({ brightness: v })}
              disabled={disabled}
              label="Brightness"
            />
          )}
          {cap?.contrast && (
            <RangeControl
              cap={cap.contrast as { min?: number; max?: number; step?: number }}
              value={state.contrast ?? setts?.contrast ?? 0}
              onChange={(v) => update({ contrast: v })}
              disabled={disabled}
              label="Contrast"
            />
          )}
        </ControlGroup>
      )}
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-fob-border bg-fob-bg p-2">
      <div className="mb-1.5 text-[9px] font-bold uppercase tracking-wider text-fob-orange">{label}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ModeToggle({ modes, value, onChange, disabled }: { modes: string[]; value: string; onChange: (m: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {modes.map((m) => (
        <button
          key={m}
          disabled={disabled}
          onClick={() => onChange(m)}
          className={`rounded px-2 py-0.5 text-[10px] font-bold transition-colors ${
            value === m
              ? "bg-fob-orange text-fob-accent-text"
              : "bg-fob-surface text-fob-text-dim hover:text-fob-text"
          } disabled:opacity-50`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function AFToggle({ modes, value, onChange, disabled }: { modes: string[]; value: string; onChange: (m: string) => void; disabled?: boolean }) {
  const canAuto = modes.includes("continuous") || modes.includes("single-shot");
  const isAuto = value === "continuous" || value === "single-shot";
  if (!canAuto && !modes.includes("manual")) return <ModeToggle modes={modes} value={value} onChange={onChange} disabled={disabled} />;
  return (
    <div className="flex items-center gap-2">
      <button
        disabled={disabled || !canAuto}
        onClick={() => onChange(isAuto ? "manual" : modes.includes("continuous") ? "continuous" : "single-shot")}
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold transition-colors ${
          isAuto
            ? "bg-fob-orange text-fob-accent-text"
            : "bg-fob-surface text-fob-text-dim hover:text-fob-text"
        } disabled:opacity-50`}
      >
        <span className={`h-2 w-2 rounded-full ${isAuto ? "bg-fob-accent-text animate-pulse" : "bg-fob-text-dim"}`} />
        AF {isAuto ? "ON" : "OFF"}
      </button>
      {!isAuto && modes.includes("manual") && (
        <span className="text-[9px] font-mono text-fob-text-dim">manual</span>
      )}
    </div>
  );
}

function RangeControl({
  cap,
  value,
  onChange,
  disabled,
  label,
}: {
  cap: { min?: number; max?: number; step?: number };
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  label: string;
}) {
  const min = cap.min ?? 0;
  const max = cap.max ?? 100;
  const step = cap.step ?? 1;
  const display = Number.isFinite(value) ? value.toFixed(step < 1 ? 2 : 0) : "–";
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-[9px] font-mono text-fob-text-dim">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-fob-orange"
      />
      <span className="w-12 text-right text-[9px] font-mono text-fob-text">{display}</span>
    </div>
  );
}

function buildConstraints(state: CameraControlState): ExtendedConstraints {
  const mc: ExtendedConstraints = {};
  if (state.focusMode) mc.focusMode = state.focusMode;
  if (state.focusDistance !== undefined) mc.focusDistance = state.focusDistance;
  if (state.exposureMode) mc.exposureMode = state.exposureMode;
  if (state.exposureTime !== undefined) mc.exposureTime = state.exposureTime;
  if (state.exposureCompensation !== undefined) mc.exposureCompensation = state.exposureCompensation;
  if (state.whiteBalanceMode) mc.whiteBalanceMode = state.whiteBalanceMode;
  if (state.colorTemperature !== undefined) mc.colorTemperature = state.colorTemperature;
  if (state.zoom !== undefined) mc.zoom = state.zoom;
  if (state.brightness !== undefined) mc.brightness = state.brightness;
  if (state.contrast !== undefined) mc.contrast = state.contrast;
  return mc;
}
