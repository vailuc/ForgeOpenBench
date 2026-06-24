import { useEffect, useRef, useState, useCallback } from "react";
import type { CameraConstraints } from "./types";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface UseCameraResult {
  stream: MediaStream | null;
  error: string;
  devices: CameraDevice[];
  activeDeviceId: string;
  selectDevice: (deviceId: string) => void;
  stopActive: () => void;
  reloadStream: () => void;
  applyConstraints: (c: Partial<CameraConstraints>) => Promise<void>;
  applyCameraConstraints: (c: MediaTrackConstraints) => Promise<void>;
  capabilities: MediaTrackCapabilities | null;
  trackSettings: MediaTrackSettings | null;
}

export function useCamera(
  initialDeviceId = "",
  initialConstraints?: CameraConstraints,
  sharedStream?: MediaStream | null,
): UseCameraResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState(initialDeviceId);
  const [capabilities, setCapabilities] = useState<MediaTrackCapabilities | null>(null);
  const [trackSettings, setTrackSettings] = useState<MediaTrackSettings | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const constraintsRef = useRef<CameraConstraints | undefined>(initialConstraints);
  const isShared = sharedStream != null;

  // When a shared stream is supplied, sync it in and read its track info.
  // We never open/stop the underlying tracks — the owner pane controls those.
  useEffect(() => {
    if (!isShared) return;
    setStream(sharedStream ?? null);
    const track = sharedStream?.getVideoTracks()[0];
    if (track) {
      setTrackSettings(track.getSettings());
      if (typeof track.getCapabilities === "function") setCapabilities(track.getCapabilities());
    } else {
      setTrackSettings(null);
      setCapabilities(null);
    }
  }, [isShared, sharedStream]);

  const stopActive = useCallback(() => {
    if (isShared) return; // owner controls the real tracks
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((t) => t.stop());
      activeStreamRef.current = null;
      setStream(null);
      setCapabilities(null);
      setTrackSettings(null);
    }
  }, [isShared]);

  const enumerateDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const vids = all
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
      setDevices(vids);
      return vids;
    } catch {
      return [];
    }
  }, []);

  const openStream = useCallback(
    async (deviceId: string, constraints?: CameraConstraints) => {
      stopActive();
      setError("");
      const c = constraints ?? constraintsRef.current;
      const w = c?.width || 1280;
      const h = c?.height || 720;
      const fps = c?.frameRate || 0;
      try {
        const videoConstraints: MediaTrackConstraints = deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: w }, height: { ideal: h } }
          : { width: { ideal: w }, height: { ideal: h } };
        if (fps > 0) videoConstraints.frameRate = { ideal: fps };

        const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        activeStreamRef.current = s;
        setStream(s);

        const track = s.getVideoTracks()[0];
        if (track) {
          setTrackSettings(track.getSettings());
          if (typeof track.getCapabilities === "function") {
            setCapabilities(track.getCapabilities());
          }
        }

        const vids = await enumerateDevices();
        if (!deviceId && vids.length > 0) {
          const matched = vids.find((d) => d.label === track?.label);
          if (matched) setActiveDeviceId(matched.deviceId);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Camera error");
        setStream(null);
      }
    },
    [stopActive, enumerateDevices]
  );

  const reloadStream = useCallback(() => {
    if (isShared) return;
    openStream(activeDeviceId, constraintsRef.current);
  }, [isShared, activeDeviceId, openStream]);

  const applyConstraints = useCallback(async (c: Partial<CameraConstraints>) => {
    const track = activeStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const mc: MediaTrackConstraints = {};
    if (c.width) mc.width = { ideal: c.width };
    if (c.height) mc.height = { ideal: c.height };
    if (c.frameRate) mc.frameRate = { ideal: c.frameRate };
    try {
      await track.applyConstraints(mc);
      setTrackSettings(track.getSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : "applyConstraints failed");
    }
  }, []);

  const applyCameraConstraints = useCallback(async (c: MediaTrackConstraints) => {
    const track = activeStreamRef.current?.getVideoTracks()[0] ?? sharedStream?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    try {
      await track.applyConstraints(c);
      setTrackSettings(track.getSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : "applyCameraConstraints failed");
    }
  }, [sharedStream]);

  useEffect(() => {
    constraintsRef.current = initialConstraints;
  }, [initialConstraints]);

  useEffect(() => {
    if (isShared) return;
    openStream(activeDeviceId);
    return () => stopActive();
  }, [activeDeviceId, isShared]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    enumerateDevices();
    navigator.mediaDevices.addEventListener("devicechange", enumerateDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", enumerateDevices);
  }, [enumerateDevices]);

  const selectDevice = useCallback((deviceId: string) => {
    setActiveDeviceId(deviceId);
  }, []);

  return {
    stream, error, devices, activeDeviceId,
    selectDevice, stopActive, reloadStream, applyConstraints, applyCameraConstraints,
    capabilities, trackSettings,
  };
}
