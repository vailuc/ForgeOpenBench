import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { BleTransport } from "./BleTransport";
import { BridgeTransport } from "./BridgeTransport";
import { MultimeterService } from "./MultimeterService";
import { StatusService } from "./StatusService";
import {
  MeterMode, MeterStatus, unitForMode, modeLabel, formatSi,
  getSwitchPosition, rangesForMode, AUTO_RANGE,
  type MeterReading, type DeviceStatus, type DeviceCharacteristics,
} from "./types";
import { StatusServiceUuids } from "./uuids";
import { Readout } from "./Readout";
import { ModeBar } from "./ModeBar";
import { toast } from "../../shared/hooks/useToastStore";
import { beep } from "./beep";
import type { PluginBus } from "../types";
import { useSettingsStore } from "../../core/settings_store";
import { useMeterHistory, TickerTape, SparklineCanvas } from "./MeterHistory";
import { getSharedTransport, setSharedTransport, setSharedMeterBusy } from "./sharedTransport";
import { globalBus } from "../../core/global_bus";
import { pushMeterSample, setMeterState } from "./sharedMeterStore";

type Transport = BleTransport | BridgeTransport;
type ConnectionState = "disconnected" | "connecting" | "reconnecting" | "connected";


interface Stats { min: number; max: number; avg: number; count: number; }
interface LastModes { V: MeterMode; A: MeterMode; Ω: MeterMode; }

const MAX_RECONNECT_ATTEMPTS = 5;
const TARE_WINDOW_SIZE = 10;
const DEEP_THRESHOLD = 0.2;
const TARE_SNAPSHOT_KEY = "pocketforge_meter_tare";
const SQRT2 = Math.sqrt(2);

function getBank(m: MeterMode): "V" | "A" | "Ω" {
  const code = m as unknown as number;
  const pos = getSwitchPosition(code);
  return pos === "V" ? "V" : pos === "A" ? "A" : "Ω";
}

export function MultimeterView({ bus, isActive }: { bus?: PluginBus; isActive?: boolean }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [deviceName, setDeviceName] = useState("");
  const [mode, setMode] = useState<MeterMode>(MeterMode.DcVoltage);
  const [range, setRange] = useState<number>(AUTO_RANGE);
  const [intervalMs, setIntervalMs] = useState(100);
  const [reading, setReading] = useState<MeterReading | null>(null);

  const [hold, setHold] = useState(false);
  const holdRef = useRef(false);
  useEffect(() => { holdRef.current = hold; }, [hold]);
  const [rel, setRel] = useState(false);
  const relRef = useRef<number | null>(null);
  const [stats, setStats] = useState<Stats>({ min: Infinity, max: -Infinity, avg: 0, count: 0 });
  const lastShortRef = useRef(false);

  const [tareActive, setTareActive] = useState(false);
  const tareActiveRef = useRef(false);
  useEffect(() => { tareActiveRef.current = tareActive; }, [tareActive]);
  const tareWindowRef = useRef<number[]>([]);
  const [tareLiveStats, setTareLiveStats] = useState<{ mean: number; range: number; count: number } | null>(null);
  const tareLiveStatsRef = useRef(tareLiveStats);
  useEffect(() => { tareLiveStatsRef.current = tareLiveStats; }, [tareLiveStats]);
  const [tareSigma, setTareSigma] = useState(2.0);
  const [tareDeep, setTareDeep] = useState(false);
  const [acJitterThreshold, setAcJitterThreshold] = useState(5.0);
  const [tareSnapshotAvailable, setTareSnapshotAvailable] = useState(false);
  const lastStableRef = useRef<number | null>(null);
  const lastWvRef = useRef<number | null>(null); // for AC delta computation

  // SNR noise calibration (one-shot, persisted per mode/range)
  const [calibratedNoise, setCalibratedNoise] = useState<{ mean: number; stdDev: number; peakToPeak: number } | null>(null);
  const [snrActive, setSnrActive] = useState(false);
  const [snrSigma, setSnrSigma] = useState(2.0);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const noiseSamplesRef = useRef<number[]>([]);
  const isCalibratingRef = useRef(false);

  const [lastModes, setLastModes] = useState<LastModes>({ V: MeterMode.DcVoltage, A: MeterMode.DcCurrent, Ω: MeterMode.Resistance });
  const [autoFollowSwitch, setAutoFollowSwitch] = useState(true);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [characteristics, setCharacteristics] = useState<DeviceCharacteristics | null>(null);

  const isActiveRef = useRef(isActive ?? true);
  useEffect(() => { isActiveRef.current = isActive ?? true; }, [isActive]);

  const [error, _setError] = useState("");
  const transportType = useSettingsStore((s) => (s.pluginTransport["pocketforge"] ?? "web")) as "web" | "bridge";
  const [, setReconnectAttempt] = useState(0);

  const transportRef = useRef<Transport | null>(getSharedTransport() as Transport | null);
  const mmServiceRef = useRef<MultimeterService | null>(null);
  const meterUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const statusUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const buttonUnsubRef = useRef<(() => Promise<void>) | null>(null);
  const initialModeSent = useRef(false);
  const settingsBusyRef = useRef(false);
  const pendingSettingsRef = useRef<{ mode: MeterMode; range: number; updateIntervalMs: number } | null>(null);
  const prevSwitchRef = useRef<string | null>(null);
  const isReconnectingRef = useRef(false);

  const [switchMismatch, setSwitchMismatch] = useState(false);
  const switchMismatchRef = useRef(false);

  const connected = connectionState === "connected";

  // Bridge connection state to main UI
  useEffect(() => {
    useSettingsStore.getState().setPluginConnected("pocketforge", connected);
  }, [connected]);

  // On mount, if a global transport already exists (from another tab), sync state
  useEffect(() => {
    const t = getSharedTransport();
    if (t && t.isConnected) {
      transportRef.current = t as Transport;
      setConnectionState("connected");
      setDeviceName(t.deviceName);
    }
  }, []);

  // Poll for shared transport connection (covers: switching to Meter tab while connecting)
  useEffect(() => {
    if (connectionState !== "disconnected") return;
    const check = () => {
      const t = getSharedTransport();
      if (t && t.isConnected) {
        transportRef.current = t as Transport;
        setConnectionState("connected");
        setDeviceName(t.deviceName);
      }
    };
    check();
    const interval = setInterval(check, 300);
    return () => clearInterval(interval);
  }, [connectionState]);

  const [autoReconnect, _setAutoReconnect] = useState(() => {
    try { return localStorage.getItem("pocketforge_autoReconnect") !== "false"; } catch { return true; }
  }); // setAutoReconnect intentionally unused — kept for future reconnect toggle UI
  const autoReconnectRef = useRef(autoReconnect);
  useEffect(() => { autoReconnectRef.current = autoReconnect; }, [autoReconnect]);

  const { push: pushHistory, reset: resetHistory, ticker, canvasRef } = useMeterHistory();

  const stopLiveBusyRef = useRef(false);
  const setupBusyRef = useRef(false);
  const stopLive = useCallback(async () => {
    if (stopLiveBusyRef.current) {
      // Already stopping — wait for the in-flight stopLive to finish
      await new Promise<void>((resolve) => {
        const unsub = globalBus.on("pocketforge.meter.released", () => { unsub(); resolve(); });
      });
      return;
    }
    stopLiveBusyRef.current = true;
    setSharedMeterBusy(true);
    try {
      if (meterUnsubRef.current) { try { await meterUnsubRef.current(); } catch { /* ignore */ } meterUnsubRef.current = null; }
      if (statusUnsubRef.current) { try { await statusUnsubRef.current(); } catch { /* ignore */ } statusUnsubRef.current = null; }
      if (buttonUnsubRef.current) { try { await buttonUnsubRef.current(); } catch { /* ignore */ } buttonUnsubRef.current = null; }
    } finally {
      stopLiveBusyRef.current = false;
      setSharedMeterBusy(false);
      globalBus.emit("pocketforge.meter.released");
    }
    mmServiceRef.current = null;
    setupBusyRef.current = false;  // clear any stalled mid-setup so next connect can run
    initialModeSent.current = false;
    prevSwitchRef.current = null;
    setReading(null);
    setStats({ min: Infinity, max: -Infinity, avg: 0, count: 0 });
    setHold(false); setRel(false); relRef.current = null; setMeterState({ rel: false, hold: false });
    lastShortRef.current = false;
    tareWindowRef.current = []; setTareLiveStats(null); setTareActive(false); setMeterState({ tare: false });
  }, []);

  const doDisconnect = useCallback(async () => {
    await stopLive();
    transportRef.current?.disconnect();
    transportRef.current = null;
    setSharedTransport(null);
    setConnectionState("disconnected");
    setReconnectAttempt(0);
    setDeviceName("");
    setDeviceStatus(null);
    setCharacteristics(null);
    toast.info("Disconnected");
  }, [stopLive]);
  const doDisconnectRef = useRef(doDisconnect); doDisconnectRef.current = doDisconnect; // future: footer disconnect

  // Load plugin settings from global config
  useEffect(() => {
    if (!bus) return;
    const handleLoaded = (payload: unknown) => {
      const p = payload as { key: string; settings: Record<string, unknown> | null };
      if (p.key === "pocketforge" && p.settings) {
        const preferred = p.settings.preferredDevice as string | undefined;
        const autoConnect = !!p.settings.autoConnectDevice;
        if (autoConnect && preferred && !connected) {
          toast.info(`Preferred device: ${preferred} — click Connect to pair`);
        }
        // Apply meter defaults
        const sigma = p.settings.tareSigma as number | undefined;
        if (sigma !== undefined) setTareSigma(sigma);
        const deep = p.settings.tareDeep as boolean | undefined;
        if (deep !== undefined) setTareDeep(deep);
        const iv = p.settings.intervalMs as number | undefined;
        if (iv !== undefined) setIntervalMs(iv);
        const af = p.settings.autoFollow as boolean | undefined;
        if (af !== undefined) setAutoFollowSwitch(af);
      }
    };
    const unsub = bus.on("plugin.settings.loaded", handleLoaded);
    bus.emit("plugin.settings.load", { key: "pocketforge" });
    return unsub;
  }, [bus, connected]);

  useEffect(() => {
    return () => {
      // Don't call stopLive() here — unsubscribing from BLE notifications
      // can trigger GATT disconnect in Chrome, causing reconnect loops during
      // React Strict Mode double-render. The isActive effect handles tab-switch.
      mmServiceRef.current = null;
    };
  }, []);

  const setupAfterConnect = useCallback(async () => {
    if (setupBusyRef.current) return;
    if (!isActiveRef.current) { setupBusyRef.current = false; return; }
    const t = transportRef.current;
    if (!t || !t.isConnected) { setupBusyRef.current = false; return; }
    setupBusyRef.current = true;
    try {
    initialModeSent.current = true; // set immediately so other effects bail out
    const mm = new MultimeterService(t);
    mmServiceRef.current = mm;

    // Critical path: subscribe to readings + push settings in parallel
    let _readCount = 0;
    const unsub = await mm.onReading((r) => {
      _readCount++;
      if (_readCount % 10 === 1) {
        console.debug(`[Meter] reading #${_readCount} mode=${r.mode} val=${r.value}`);
      }
      setReading(r);
      // When switch position doesn't match selected mode, device returns readings
      // for the wrong mode. Freeze data processing until user rotates dial.
      if (switchMismatchRef.current) return;
      if (r.status !== MeterStatus.Error) {
        // Compute processed display value (REL + TARE) same as Meter stats
        let displayValue = r.value;
        if (!holdRef.current && mode !== MeterMode.Continuity) {
          if (relRef.current !== null) displayValue = r.value - relRef.current;
          if (tareActiveRef.current && tareLiveStatsRef.current && mode !== MeterMode.AcVoltage && mode !== MeterMode.AcCurrent) {
            displayValue = displayValue - tareLiveStatsRef.current.mean;
          }
        }
        pushHistory(r.value, formatSi(r.value, unitForMode(mode)));
        pushMeterSample({ timestamp: Date.now(), value: displayValue, unit: unitForMode(r.mode), mode: modeLabel(r.mode) });
      }
      // SNR calibration: collect samples when calibrating
      if (isCalibratingRef.current && r.status !== MeterStatus.Error && mode !== MeterMode.Continuity) {
        const calVal = relRef.current !== null ? r.value - relRef.current : r.value;
        noiseSamplesRef.current.push(calVal);
        if (noiseSamplesRef.current.length >= 50) {
          const vals = noiseSamplesRef.current;
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length;
          const stdDev = Math.sqrt(variance);
          const peakToPeak = Math.max(...vals) - Math.min(...vals);
          setCalibratedNoise({ mean, stdDev, peakToPeak });
          isCalibratingRef.current = false;
          setIsCalibrating(false);
          noiseSamplesRef.current = [];
          toast.success(`Noise calibrated: ±${formatSi(stdDev * snrSigma, unitForMode(mode))}`);
        }
      }
      if (!holdRef.current && r.status !== MeterStatus.Error && mode !== MeterMode.Continuity) {
        if (tareActiveRef.current && Number.isFinite(r.value)) {
          const wv = relRef.current !== null ? r.value - relRef.current : r.value;
          const w = tareWindowRef.current;
          if (mode === MeterMode.AcVoltage || mode === MeterMode.AcCurrent) {
            // AC: window stores deltas (jitter), not raw values
            const prev = lastWvRef.current ?? wv;
            const delta = Math.abs(wv - prev);
            w.push(delta);
            lastWvRef.current = wv;
            // Seed lastStableRef on first AC reading
            if (lastStableRef.current === null) lastStableRef.current = wv;
          } else {
            w.push(wv);
          }
          if (w.length > TARE_WINDOW_SIZE) w.shift();
          if (w.length >= 3) {
            const mean = w.reduce((a, b) => a + b, 0) / w.length;
            setTareLiveStats({ mean, range: Math.max(...w) - Math.min(...w), count: w.length });
          }
        }
        let v = relRef.current !== null ? r.value - relRef.current : r.value;
        if (tareActiveRef.current && tareLiveStatsRef.current && mode !== MeterMode.AcVoltage && mode !== MeterMode.AcCurrent) {
          v = v - tareLiveStatsRef.current.mean;
        }
        setStats((p) => { const n = p.count + 1; return { min: Math.min(p.min, v), max: Math.max(p.max, v), avg: (p.avg * p.count + v) / n, count: n }; });
      }
      if (mode === MeterMode.Continuity && !holdRef.current) {
        const isShort = r.status !== MeterStatus.AutoRangeOn;
        if (isShort && !lastShortRef.current) beep();
        lastShortRef.current = isShort;
      }
    });
    meterUnsubRef.current = unsub;

    // Web BT: give Chromium time to settle GATT notifications before writing.
    // A writeValueWithResponse immediately after startNotifications can silently
    // freeze the notification stream in Chromium's GATT scheduler.
    if (!(t as any).rpc) await new Promise((r) => setTimeout(r, 150));

    settingsBusyRef.current = true;
    try {
      await mm.setSettings({ mode, range, updateIntervalMs: intervalMs });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("NotSupportedError") || msg.includes("GATT operation") || msg.includes("GATT Protocol Error")) {
        // Pokit Pro firmware can't handle startNotifications + writeValue simultaneously;
        // wait for notifications to settle then retry once
        await new Promise((res) => setTimeout(res, 200));
        if (!transportRef.current?.isConnected) { console.warn("setSettings retry skipped: GATT disconnected during wait"); return; }
        try {
          await mm.setSettings({ mode, range, updateIntervalMs: intervalMs });
        } catch (e2) {
          console.warn("setSettings retry failed:", e2);
        }
      } else {
        console.warn("setSettings failed:", e);
      }
    } finally {
      settingsBusyRef.current = false;
    }

    // Non-critical: status service in background — serialize ALL reads to avoid
    // saturating the Pokit Pro ATT bearer (concurrent GATT ops lock up firmware)
    (async () => {
      try {
        let statusUuid: string = StatusServiceUuids.pokitPro;
        try { await t.readCharacteristic(statusUuid, StatusServiceUuids.characteristics.status); }
        catch { statusUuid = StatusServiceUuids.pokitMeter; }
        const ss = new StatusService(t, statusUuid);
        const chars = await ss.readDeviceCharacteristics();
        setCharacteristics(chars);
        await new Promise((r) => setTimeout(r, 80));
        if (!transportRef.current?.isConnected) return;
        const initialStatus = await ss.readStatus();
        setDeviceStatus(initialStatus);
        await new Promise((r) => setTimeout(r, 80));
        if (!transportRef.current?.isConnected) return;
        const devName = await ss.readName().catch(() => t.deviceName);
        setDeviceName(devName);
        await new Promise((r) => setTimeout(r, 80));
        if (!transportRef.current?.isConnected) return;
        statusUnsubRef.current = await ss.onStatus((s) => setDeviceStatus(s));
        await new Promise((r) => setTimeout(r, 80));
        if (!transportRef.current?.isConnected) return;
        try {
          buttonUnsubRef.current = await ss.onButtonPress((raw) => {
            const isRelease = raw.length >= 2 && raw[1] === 0x00;
            if (isRelease) handleSaveRef.current();
          });
        } catch { }
      } catch (e) { console.warn("Status setup failed:", e); }
    })();
    } finally {
      setupBusyRef.current = false;
      // If onReading never completed, mark setup as not done so the next
      // connection event (or isActive effect) will retry. Without this,
      // initialModeSent stays true after a mid-setup failure and meter
      // data never arrives after a silent server-side auto-reconnect.
      if (!meterUnsubRef.current) {
        initialModeSent.current = false;
      }
    }
  }, [mode, range, intervalMs]);

  // Auto-subscribe when connection first becomes ready (initial connect, reconnect)
  // isActive effect handles the tab-switch case separately
  useEffect(() => {
    if (connectionState === "connected" && !initialModeSent.current && isActive) {
      void setupAfterConnect();
    }
  }, [connectionState, setupAfterConnect, isActive]);

  const setupAfterConnectRef = useRef(setupAfterConnect);
  useEffect(() => { setupAfterConnectRef.current = setupAfterConnect; }, [setupAfterConnect]);

  // Unsubscribe from BLE when tab is hidden; re-subscribe when returning
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = isActive ?? true;
    if (!isActive) {
      // Leaving Meter tab — stop live and clear state
      void stopLive();
      initialModeSent.current = false;
    } else if (!wasActive && isActive && connectionState === "connected") {
      // Returning TO Meter tab — await stopLive (may still be running from above),
      // then force-reset and re-subscribe. The 200ms delay lets gatt_unsubscribe
      // on the server settle before we issue gatt_subscribe again.
      const t = transportRef.current;
      if (t && t.isConnected) {
        stopLive().then(() => {
          initialModeSent.current = false;
          setupBusyRef.current = false;
          return new Promise<void>((r) => setTimeout(r, 200));
        }).then(() => {
          if (transportRef.current?.isConnected) void setupAfterConnectRef.current();
        });
      }
    }
  }, [isActive, connectionState, stopLive]);

  useEffect(() => {
    const t = transportRef.current;
    if (!t) return;
    const off = t.onConnectionChange((isConnected) => {
      if (isConnected) {
        setConnectionState("connected");
        setReconnectAttempt(0);
        return;
      }
      // Only auto-reconnect if we had previously completed setup; otherwise a
      // failed initial connect (e.g. device not present) will loop forever.
      const wasEstablished = initialModeSent.current;
      initialModeSent.current = false; // allow re-setup after reconnect
      if (t.wasIntentionalDisconnect || !wasEstablished) {
        setConnectionState("disconnected");
        return;
      }
      // Transition to disconnected so the isActive + connectionState effect
      // will fire setupAfterConnect when the connection comes back. If we keep
      // the state at "connected" across the auto-reconnect, React won't re-run
      // the effect and the meter will silently stop receiving data.
      setConnectionState("disconnected");
      if (autoReconnectRef.current && isActiveRef.current && !isReconnectingRef.current) {
        isReconnectingRef.current = true;
        void attemptReconnect();
      }
    });
    return off;
  }, []); // Never re-register; refs keep values fresh

  const attemptReconnect = useCallback(async () => {
    const t = transportRef.current;
    if (!t || !t.canReconnect) {
      isReconnectingRef.current = false;
      setConnectionState("disconnected");
      return;
    }
    for (let a = 1; a <= MAX_RECONNECT_ATTEMPTS; a++) {
      // If already connected and setup succeeded, nothing to do
      if (t.isConnected && initialModeSent.current) {
        isReconnectingRef.current = false;
        return;
      }
      setConnectionState("reconnecting"); setReconnectAttempt(a);
      if (a === 1) toast.warning("Connection lost — reconnecting...");
      try {
        if (!t.isConnected) await t.reconnect();
        await setupAfterConnect();
        setConnectionState("connected"); setReconnectAttempt(0); useSettingsStore.getState().setPluginTransport("pocketforge", transportType); toast.success("Reconnected"); return;
      }
      catch { await new Promise((r) => setTimeout(r, 500 * 2 ** (a - 1))); }
    }
    isReconnectingRef.current = false;
    setConnectionState("disconnected"); setReconnectAttempt(0); toast.error("Could not reconnect");
  }, [setupAfterConnect]);


  useEffect(() => {
    if (!initialModeSent.current) return;
    const mm = mmServiceRef.current; if (!mm) return;
    if (!transportRef.current?.isConnected) return;

    const send = async (s: { mode: MeterMode; range: number; updateIntervalMs: number }) => {
      if (settingsBusyRef.current) {
        pendingSettingsRef.current = s;
        return;
      }
      settingsBusyRef.current = true;
      try {
        await mm.setSettings(s);
        setSwitchMismatch(false); switchMismatchRef.current = false;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("0x80")) {
          setSwitchMismatch(true); switchMismatchRef.current = true;
          toast.warning(`Switch position mismatch — rotate dial to ${getBank(s.mode) === "V" ? "Voltage" : getBank(s.mode) === "A" ? "Current" : "Ω"}`);
        } else {
          console.warn("setSettings failed:", e);
        }
      } finally {
        settingsBusyRef.current = false;
        const pending = pendingSettingsRef.current;
        if (pending && (pending.mode !== s.mode || pending.range !== s.range || pending.updateIntervalMs !== s.updateIntervalMs)) {
          pendingSettingsRef.current = null;
          await send(pending);
        }
      }
    };

    void send({ mode, range, updateIntervalMs: intervalMs });
  }, [mode, range, intervalMs]);

  useEffect(() => {
    setStats({ min: Infinity, max: -Infinity, avg: 0, count: 0 });
    relRef.current = null; setRel(false); setHold(false); setMeterState({ rel: false, hold: false }); lastShortRef.current = false;
    tareWindowRef.current = []; setTareLiveStats(null); setTareActive(false); lastStableRef.current = null; lastWvRef.current = null;
    try { const s = localStorage.getItem(TARE_SNAPSHOT_KEY); setTareSnapshotAvailable(!!s && JSON.parse(s).mode === mode && JSON.parse(s).range === range); }
    catch { setTareSnapshotAvailable(false); }
  }, [mode, range]);

  const switchPos = deviceStatus ? getSwitchPosition(deviceStatus.status) : (prevSwitchRef.current ?? null);
  useEffect(() => {
    if (!connected || !deviceStatus || !autoFollowSwitch) return;
    const pos = getSwitchPosition(deviceStatus.status);
    if (pos === "idle" || pos === "logger") return;
    if (prevSwitchRef.current !== pos) {
      prevSwitchRef.current = pos;
      const target = lastModes[pos as keyof LastModes];
      if (mode !== target) { setMode(target); setRange(AUTO_RANGE); }
    }
  }, [connected, deviceStatus, autoFollowSwitch, lastModes, mode]);

  // If user manually picked a mode and then rotated the dial to match,
  // clear the mismatch flag and retry setSettings so readout resumes.
  useEffect(() => {
    if (!switchMismatch || !switchPos) return;
    if (getBank(mode) === switchPos) {
      setSwitchMismatch(false); switchMismatchRef.current = false;
      // setSettings will be retried by the mode effect on next render,
      // but force it now if the mode already matches
      const mm = mmServiceRef.current;
      if (mm && transportRef.current?.isConnected && !settingsBusyRef.current) {
        settingsBusyRef.current = true;
        mm.setSettings({ mode, range, updateIntervalMs: intervalMs })
          .catch(() => {})
          .finally(() => { settingsBusyRef.current = false; });
      }
    }
  }, [switchPos, mode, switchMismatch, range, intervalMs]);

  const unit = unitForMode(mode);

  const isAc = mode === MeterMode.AcVoltage || mode === MeterMode.AcCurrent;

  const { displayValue, isGated } = useMemo(() => {
    if (switchMismatch) return { displayValue: "--", isGated: false };
    if (!reading || reading.status === MeterStatus.Error) return { displayValue: `-- ${unit}`.trim(), isGated: false };
    if (mode === MeterMode.Continuity) return { displayValue: reading.status === MeterStatus.AutoRangeOn ? "OPEN" : "SHORT", isGated: false };
    const relOff = rel && relRef.current !== null ? relRef.current : 0;
    const tared = reading.value - relOff;
    const toDisplay = (v: number) => isAc ? v / SQRT2 : v;
    // SNR gate: after REL/TARE, clamp within ±σ of calibrated noise to zero
    if (snrActive && calibratedNoise && !isAc) {
      const centered = tared - calibratedNoise.mean;
      const threshold = calibratedNoise.stdDev * snrSigma;
      if (Math.abs(centered) < threshold) return { displayValue: "0.000", isGated: true };
      return { displayValue: formatSi(toDisplay(centered), unit), isGated: false };
    }
    if (tareActive && tareLiveStats) {
      if (isAc) {
        // AC: manual jitter deadband
        const thresh = acJitterThreshold;
        // Squelch floor: gate to 0.000 when signal is below threshold (open probes / ambient)
        if (Math.abs(tared) < thresh) return { displayValue: "0.000", isGated: true };
        // Jitter suppression: only update when change from last stable exceeds threshold
        const ls = lastStableRef.current;
        if (ls !== null && Math.abs(tared - ls) < thresh) {
          return { displayValue: formatSi(toDisplay(ls), unit), isGated: false };
        }
        lastStableRef.current = tared;
        return { displayValue: formatSi(toDisplay(tared), unit), isGated: false };
      }
      // DC: zeroing — subtract mean, gate within noise to 0.000
      const noise = (tareLiveStats.range / 2) * tareSigma;
      const thresh = tareDeep ? Math.max(noise, DEEP_THRESHOLD) : noise;
      const centered = tared - tareLiveStats.mean;
      if (Math.abs(centered) < thresh) return { displayValue: "0.000", isGated: true };
      return { displayValue: formatSi(toDisplay(centered), unit), isGated: false };
    }
    return { displayValue: formatSi(toDisplay(tared), unit), isGated: false };
  }, [reading, rel, tareActive, tareLiveStats, mode, unit, tareSigma, tareDeep, snrActive, calibratedNoise, snrSigma]);

  const statsDisplay = useMemo(() => {
    if (!stats.count || mode === MeterMode.Continuity) return null;
    const toRms = (v: number) => isAc ? v / SQRT2 : v;
    const items = [
      { label: "Min", value: formatSi(toRms(stats.min), unit) },
      { label: "Max", value: formatSi(toRms(stats.max), unit) },
      { label: "Avg", value: formatSi(toRms(stats.avg), unit) },
      ...(isAc
        ? [{ label: "PTP", value: formatSi(stats.max - stats.min, unit) }]
        : []),
    ];
    if (tareActive && tareLiveStats) {
      if (isAc) {
        items.push({ label: "Jitter", value: `±${formatSi(acJitterThreshold, unit)}` });
      } else {
        const noise = (tareLiveStats.range / 2) * tareSigma;
        items.push({ label: "Floor", value: `±${formatSi(tareDeep ? Math.max(noise, DEEP_THRESHOLD) : noise, unit)}` });
      }
    }
    return items;
  }, [stats, mode, unit, tareActive, tareLiveStats]);

  const currentRangeLabel = useMemo(() => { if (range === AUTO_RANGE) return "Auto"; const r = rangesForMode(mode).find((x) => x.value === range); return r?.label ?? "Auto"; }, [mode, range]);
  const rangeOptions = useMemo(() => { const r = rangesForMode(mode); return r.length ? [{ value: AUTO_RANGE, label: "Auto" }, ...r] : []; }, [mode]);

  const handleModeClick = (m: MeterMode) => {
    const bank = getBank(m);
    setLastModes((p) => ({ ...p, [bank]: m }));
    setMode(m); setRange(AUTO_RANGE);
  };

  const handleRel = () => {
    if (rel) { setRel(false); relRef.current = null; setMeterState({ rel: false }); }
    else if (reading && reading.status !== MeterStatus.Error && mode !== MeterMode.Continuity) { relRef.current = reading.value; setRel(true); setMeterState({ rel: true }); }
  };

  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const inInput = (e.target instanceof HTMLElement) &&
        (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
      if (inInput) return;
      if (e.key === "h" || e.key === "H") { e.preventDefault(); setHold((h) => { const next = !h; setMeterState({ hold: next }); return next; }); }
      if (e.key === "r" || e.key === "R") { e.preventDefault(); handleRel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, handleRel]);

  const handleTare = () => {
    if (tareActive) {
      if (tareLiveStats) {
        localStorage.setItem(TARE_SNAPSHOT_KEY, JSON.stringify({ mode, range, window: tareWindowRef.current.slice(), mean: tareLiveStats.mean, rangeValue: tareLiveStats.range, count: tareLiveStats.count, savedAt: new Date().toISOString() }));
        setTareSnapshotAvailable(true);
      }
      setTareActive(false); tareWindowRef.current = []; setTareLiveStats(null); lastStableRef.current = null; lastWvRef.current = null; setMeterState({ tare: false }); toast.info("Tare cleared");
    } else { setTareActive(true); tareWindowRef.current = []; setTareLiveStats(null); lastStableRef.current = null; lastWvRef.current = null; setMeterState({ tare: true }); toast.info("Tare active — collecting noise floor..."); }
  };

  const handleRestoreTare = () => {
    try {
      const saved = localStorage.getItem(TARE_SNAPSHOT_KEY); if (!saved) return;
      const snap = JSON.parse(saved);
      if (snap.mode !== mode || snap.range !== range) { toast.error("Snapshot was for a different mode/range"); return; }
      tareWindowRef.current = snap.window || [];
      setTareLiveStats({ mean: snap.mean, range: snap.rangeValue, count: snap.count });
      setTareActive(true); setTareSnapshotAvailable(false); setMeterState({ tare: true }); toast.success(`Restored tare (${snap.count} samples)`);
    } catch { toast.error("Failed to restore tare"); }
  };

  const handleReset = () => {
    setStats({ min: Infinity, max: -Infinity, avg: 0, count: 0 });
    relRef.current = null; setRel(false); setHold(false); setMeterState({ rel: false, hold: false });
    lastShortRef.current = false;
    tareWindowRef.current = []; setTareLiveStats(null); setTareActive(false); lastStableRef.current = null; lastWvRef.current = null;
    resetHistory();
  };

  const handleClearHistory = () => {
    resetHistory();
    setStats({ min: Infinity, max: -Infinity, avg: 0, count: 0 });
    toast.info("Plot & ticker cleared");
  };

  const isSavingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (isSavingRef.current || !reading || reading.status === MeterStatus.Error) return;
    isSavingRef.current = true;
    const name = `${modeLabel(mode)} ${new Date().toLocaleTimeString()}`;
    const noiseThreshold = tareActive && tareLiveStats ? (tareLiveStats.range / 2) * tareSigma : null;
    const effectiveThreshold = tareActive && tareLiveStats ? (tareDeep ? Math.max(noiseThreshold!, DEEP_THRESHOLD) : noiseThreshold!) : null;
    const savedValue = isAc ? reading.value / SQRT2 : reading.value;
    const payload = { plugin: "pocketforge", name, timestamp: Date.now(), value: savedValue, unit, mode: modeLabel(mode), range: currentRangeLabel, tare: tareActive ? { active: true, sigma: tareSigma, deep: tareDeep, acJitter: isAc ? acJitterThreshold : undefined, noiseThreshold, effectiveThreshold, windowSize: tareLiveStats?.count ?? 0 } : undefined, meta: { deviceName, rel, hold } };
    try {
      const resp = await fetch("/api/v1/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      toast.success("Saved to server");
    } catch {
      toast.success("Saved locally");
      localStorage.setItem(`fob_capture_${Date.now()}`, JSON.stringify(payload));
    } finally {
      isSavingRef.current = false;
    }
  }, [reading, mode, unit, currentRangeLabel, tareActive, tareLiveStats, deviceName, rel, hold, isAc]);

  const handleSaveRef = useRef(handleSave);
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);


  const tareDelta = useMemo(() => {
    if (!tareActive || !tareLiveStats || !reading || reading.status === MeterStatus.Error || mode === MeterMode.Continuity) return null;
    const relOff = rel && relRef.current !== null ? relRef.current : 0;
    if (isAc) {
      // AC: manual jitter deadband
      const jitterThresh = acJitterThreshold;
      const ls = lastStableRef.current ?? reading.value - relOff;
      const jitterRaw = Math.abs((reading.value - relOff) - ls);
      const jitter = jitterRaw / SQRT2; // show in RMS
      const ratio = jitterRaw / (jitterThresh || 1);
      const color: "green" | "yellow" | "red" = ratio < 0.33 ? "green" : ratio < 0.8 ? "yellow" : "red";
      return { color, delta: jitter, threshold: jitterThresh, ratio };
    }
    // DC: threshold from window range
    const noise = (tareLiveStats.range / 2) * tareSigma;
    const thresh = tareDeep ? Math.max(noise, DEEP_THRESHOLD) : noise;
    const centered = Math.abs((reading.value - relOff) - tareLiveStats.mean);
    const ratio = centered / thresh;
    const color: "green" | "yellow" | "red" = ratio < 0.33 ? "green" : ratio < 0.8 ? "yellow" : "red";
    return { color, delta: centered, threshold: thresh, ratio };
  }, [tareActive, tareLiveStats, reading, rel, mode, tareSigma, tareDeep, acJitterThreshold]);

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {error && (
        <div className="text-xs font-mono text-fob-red bg-fob-red/10 border border-fob-red/30 rounded p-3 space-y-1 shrink-0">
          <div className="font-bold">Connection failed</div>
          <div>{error}</div>
          {error.includes("timed out") && <div className="text-fob-text-dim">Tip: Make sure the Pokit is not already connected to another app or the bridge.</div>}
        </div>
      )}

      <div className="shrink-0">
        {statsDisplay && (
          <div className="flex justify-center gap-4 mb-2">
            {statsDisplay.map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-[10px] uppercase tracking-wider text-fob-text-dim">{s.label}</div>
                <div className="font-mono text-sm text-fob-text">{s.value}</div>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          {/* Ticker Tape */}
          <div className="w-36 shrink-0 h-32 overflow-hidden rounded border border-fob-border/30 bg-fob-bg/50 p-1">
            <TickerTape entries={ticker} />
          </div>

          {/* Main Readout */}
          <div className="flex-1 min-w-0 relative rounded-lg border border-fob-border bg-fob-surface p-5 flex flex-col items-center justify-center gap-2">
            <div className="absolute right-4 top-4 rounded-full bg-fob-bg px-2.5 py-0.5 text-xs font-medium text-fob-text-dim">{currentRangeLabel}</div>
            <div className="absolute top-3 left-3 flex flex-col gap-1.5">
              {switchMismatch && <span className="rounded-full bg-fob-red/80 px-2 py-0.5 text-[10px] font-bold text-fob-text">MISMATCH</span>}
              {hold && <span className="rounded-full bg-fob-orange/80 px-2 py-0.5 text-[10px] font-bold text-fob-accent-text">HOLD</span>}
              {rel && <span className="rounded-full bg-fob-orange/80 px-2 py-0.5 text-[10px] font-bold text-fob-accent-text">REL</span>}
              {tareActive && <span className="rounded-full bg-fob-green/80 px-2 py-0.5 text-[10px] font-bold text-fob-text">{isAc ? `JITTER ±${acJitterThreshold}${unit}` : `TARE ${tareSigma}σ`}</span>}
              {snrActive && calibratedNoise && <span className="rounded-full bg-fuchsia-600/80 px-2 py-0.5 text-[10px] font-bold text-fob-accent-text">SNR {snrSigma}σ</span>}
            </div>
            <Readout
              value={displayValue}
              label={modeLabel(mode)}
              sub={
                !connected ? "Connect a device to begin"
                : switchMismatch ? "Switch mismatch — rotate dial"
                : !reading ? "Waiting for reading..."
                : reading.status === MeterStatus.Error ? "Error / out of range"
                : isGated ? "Gated"
                : tareDelta
                  ? mode === MeterMode.AcVoltage || mode === MeterMode.AcCurrent
                    ? tareDelta.color === "green" ? "Stable" : `● Jitter ${formatSi(tareDelta.delta, unit)}`
                    : `${tareDelta.color === "green" ? "●" : tareDelta.color === "yellow" ? "●" : "●"} Δ ${formatSi(tareDelta.delta, unit)}`
                : undefined
              }
              gated={isGated}
            />
          </div>

          {/* Sparkline */}
          <div className="w-36 shrink-0 h-32">
            <SparklineCanvas canvasRef={canvasRef} />
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-3 min-h-0 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button onClick={() => { setHold((h) => { const next = !h; setMeterState({ hold: next }); return next; }); }} className={`px-3 py-1 rounded text-xs font-mono border ${hold ? "bg-fob-orange/80 text-fob-accent-text border-fob-orange/80" : "bg-fob-bg text-fob-text border-fob-border"}`}>{hold ? "Release" : "Hold"}</button>
          <button onClick={handleSave} disabled={!connected || !reading || reading.status === MeterStatus.Error} className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border disabled:opacity-30">Save</button>
          <button onClick={handleRel} className={`px-3 py-1 rounded text-xs font-mono border ${rel ? "bg-fob-orange/80 text-fob-accent-text border-fob-orange/80" : "bg-fob-bg text-fob-text border-fob-border"}`}>{rel ? "REL On" : "REL"}</button>
          <button onClick={handleTare} className={`px-3 py-1 rounded text-xs font-mono border ${tareActive ? "bg-fob-green/80 text-fob-text border-fob-green/80" : "bg-fob-bg text-fob-text border-fob-border"}`}>{tareActive ? "TARE On" : "TARE"}</button>
          <button
            onClick={() => { if (isCalibrating) { isCalibratingRef.current = false; setIsCalibrating(false); noiseSamplesRef.current = []; toast.info("Calibration cancelled"); } else { noiseSamplesRef.current = []; isCalibratingRef.current = true; setIsCalibrating(true); toast.info("Calibrating noise — keep probes still..."); } }}
            className={`px-3 py-1 rounded text-xs font-mono border ${isCalibrating ? "bg-fuchsia-600/80 text-fob-accent-text border-fuchsia-600/80" : calibratedNoise ? "bg-fob-bg text-fob-text border-fob-border" : "bg-fob-bg text-fob-text-dim border-fob-border"}`}
            title={calibratedNoise ? `Mean: ${formatSi(calibratedNoise.mean, unit)}, σ: ${formatSi(calibratedNoise.stdDev, unit)}` : "Calibrate noise floor"}
          >
            {isCalibrating ? "Calibrating..." : calibratedNoise ? "Re-Cal" : "Calibrate"}
          </button>
          <button
            onClick={() => setSnrActive((a) => !a)}
            disabled={!calibratedNoise}
            className={`px-3 py-1 rounded text-xs font-mono border ${snrActive ? "bg-fuchsia-600/80 text-fob-accent-text border-fuchsia-600/80" : "bg-fob-bg text-fob-text border-fob-border"} disabled:opacity-30`}
            title={calibratedNoise ? `Clamp within ±${snrSigma}σ = ${formatSi(calibratedNoise.stdDev * snrSigma, unit)}` : "Calibrate first"}
          >
            {snrActive ? "SNR On" : "SNR"}
          </button>
          {snrActive && calibratedNoise && (
            <label className="flex items-center gap-1 text-[10px] font-mono text-fob-text-dim">
              <span>σ</span>
              <input type="range" min={1} max={5} step={0.5} value={snrSigma} onChange={(e) => setSnrSigma(Number(e.target.value))} className="w-16 accent-fob-orange" />
              <span className="w-6 text-right">{snrSigma}</span>
            </label>
          )}
          {tareActive && (
            <>
              {isAc ? (
                <label className="flex items-center gap-1 text-[10px] font-mono text-fob-text-dim">
                  <span>Jitter</span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={acJitterThreshold}
                    onChange={(e) => setAcJitterThreshold(Number(e.target.value))}
                    className="w-14 bg-fob-bg border border-fob-border rounded px-1 text-right text-fob-text accent-fob-orange"
                  />
                  <span>{unit}</span>
                </label>
              ) : (
                <>
                  <label className="flex items-center gap-1 text-[10px] font-mono text-fob-text-dim">
                    <span>σ</span>
                    <input type="range" min={0.5} max={3.0} step={0.1} value={tareSigma} onChange={(e) => setTareSigma(Number(e.target.value))} className="w-16 accent-fob-orange" />
                    <span className="w-6 text-right">{tareSigma.toFixed(1)}</span>
                  </label>
                  <label className="flex items-center gap-1 text-[10px] font-mono text-fob-text-dim cursor-pointer">
                    <input type="checkbox" checked={tareDeep} onChange={(e) => setTareDeep(e.target.checked)} className="accent-fob-orange w-3 h-3" />
                    Deep
                  </label>
                </>
              )}
            </>
          )}
          {tareSnapshotAvailable && <button onClick={handleRestoreTare} className="px-3 py-1 rounded text-xs font-mono border bg-fob-bg text-fob-text border-fob-border">Restore Tare</button>}
          <label className="flex items-center gap-1.5 text-xs text-fob-text-dim ml-auto">
            <input type="checkbox" checked={autoFollowSwitch} onChange={(e) => setAutoFollowSwitch(e.target.checked)} className="accent-fob-orange" />
            Auto-follow
          </label>
        </div>

        <div className="shrink-0 flex gap-2">
          <button onClick={handleClearHistory} className="px-3 py-1 rounded text-xs font-mono bg-fob-orange/10 text-fob-orange border border-fob-orange/30 hover:bg-fob-orange/20">Clear Plot</button>
          <button onClick={handleReset} className="px-3 py-1 rounded text-xs font-mono bg-fob-red/10 text-fob-red border border-fob-red/30 hover:bg-fob-red/20">Reset All</button>
        </div>

        <ModeBar currentMode={mode} onSelect={handleModeClick} switchPos={switchPos} />

        <div className="grid gap-3 sm:grid-cols-2 shrink-0">
          <div className="rounded border border-fob-border bg-fob-surface p-3">
            <div className="text-xs font-mono text-fob-text-dim mb-2">Range</div>
            {rangeOptions.length
              ? <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="w-full bg-fob-bg text-fob-text text-xs font-mono rounded border border-fob-border px-2 py-1">{rangeOptions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
              : <p className="text-xs text-fob-text-dim">No range selection for this mode.</p>
            }
          </div>
          <div className="rounded border border-fob-border bg-fob-surface p-3">
            <div className="text-xs font-mono text-fob-text-dim mb-2">Update interval: {intervalMs} ms</div>
            <input type="range" min={1} max={500} step={1} value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} className="w-full accent-fob-orange" />
          </div>
        </div>

        {characteristics && (
          <div className="text-[10px] font-mono text-fob-text-dim space-y-0.5 shrink-0">
            <div>FW {characteristics.firmwareVersion} · MAC {characteristics.macAddress}</div>
            <div>Max {characteristics.maximumVoltage}V / {characteristics.maximumCurrent}A / {characteristics.maximumResistance}Ω</div>
          </div>
        )}
      </div>
    </div>
  );
}
