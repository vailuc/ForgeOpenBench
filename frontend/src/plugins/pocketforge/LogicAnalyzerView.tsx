import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { DsoService } from "./DsoService";
import { getSharedTransport } from "./sharedTransport";
import { MeterMode, DsoCommand } from "./types";
import { useDsoStream } from "./useDsoStream";
import type { PluginBus } from "../types";

interface LogicAnalyzerViewProps {
  bus?: PluginBus;
  isActive?: boolean;
}

interface DecodedPacket {
  type: "uart";
  timestamp: number;
  data: number;
  valid: boolean;
}

interface SignalStats {
  mean: number;
  span: number;
  min: number;
  max: number;
  snrDb: number | null;
  suggestedThreshold: number;
}

/** Compute signal stats from raw samples */
function computeStats(samples: Float64Array): SignalStats {
  if (samples.length === 0) return { mean: 0, span: 0, min: 0, max: 0, snrDb: null, suggestedThreshold: 1.5 };
  let min = samples[0], max = samples[0], sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / samples.length;
  const span = max - min;
  // Proper SNR: signal span vs noise (std dev of residual from mean)
  let variance = 0;
  for (let i = 0; i < samples.length; i++) {
    const d = samples[i] - mean;
    variance += d * d;
  }
  variance /= samples.length;
  const stdDev = Math.sqrt(variance);
  const snrDb = stdDev > 0 ? 20 * Math.log10(span / stdDev) : null;
  const suggestedThreshold = span > 0.2 ? min + span * 0.5 : 1.5;
  return { mean, span, min, max, snrDb, suggestedThreshold };
}

/** Convert analog samples to digital bits via voltage threshold */
function thresholdSamples(samples: Float64Array, threshold: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < samples.length; i++) {
    bits.push(samples[i] > threshold);
  }
  return bits;
}

/** Decode UART from thresholded bits. Returns packets and bit annotations. */
function decodeUart(bits: boolean[], sampleRate: number, baudRate: number): { packets: DecodedPacket[]; annotatedBits: { value: boolean; startByte: number; bitIndex: number }[] } {
  const packets: DecodedPacket[] = [];
  const annotatedBits: { value: boolean; startByte: number; bitIndex: number }[] = [];
  const samplesPerBit = Math.round(sampleRate / baudRate);
  if (samplesPerBit < 3) return { packets, annotatedBits };

  let i = 0;
  while (i < bits.length) {
    // Look for start bit (high → low transition, then low for ~1 bit)
    if (bits[i]) { i++; continue; }

    // Potential start bit — center sample
    const startCenter = i + Math.floor(samplesPerBit / 2);
    if (startCenter >= bits.length || bits[startCenter]) { i++; continue; }

    // Verify start bit is low across the bit period
    let startValid = true;
    for (let s = i; s < Math.min(i + samplesPerBit, bits.length); s++) {
      if (bits[s]) { startValid = false; break; }
    }
    if (!startValid) { i++; continue; }

    // Sample 8 data bits at bit centers
    let byte = 0;
    let byteValid = true;
    const bitCenters: number[] = [];
    for (let b = 0; b < 8; b++) {
      const center = startCenter + (b + 1) * samplesPerBit;
      bitCenters.push(center);
      if (center >= bits.length) { byteValid = false; break; }
      if (bits[center]) byte |= (1 << b);
    }
    if (!byteValid) { i++; continue; }

    // Check stop bit
    const stopCenter = startCenter + 9 * samplesPerBit;
    if (stopCenter >= bits.length || !bits[stopCenter]) { i++; continue; }

    // Valid byte decoded
    packets.push({
      type: "uart",
      timestamp: Date.now(),
      data: byte,
      valid: true,
    });

    // Annotate bits for waveform display
    for (let s = i; s < Math.min(stopCenter + Math.floor(samplesPerBit / 2), bits.length); s++) {
      const relativePos = s - i;
      const bitIdx = Math.floor(relativePos / samplesPerBit);
      annotatedBits.push({ value: bits[s], startByte: packets.length - 1, bitIndex: bitIdx });
    }

    i = stopCenter + Math.floor(samplesPerBit / 2);
  }

  return { packets, annotatedBits };
}

export function LogicAnalyzerView({ bus: _bus, isActive: _isActive }: LogicAnalyzerViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLive, setIsLive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [threshold, setThreshold] = useState(1.5);
  const [autoThreshold, setAutoThreshold] = useState(true);
  const [baudRate, setBaudRate] = useState(115200);
  const [snrGate, setSnrGate] = useState(false);
  const [snrThreshold, setSnrThreshold] = useState(-20);
  const [relActive, setRelActive] = useState(false);
  const [relValue, setRelValue] = useState<number | null>(null);
  const [packets, setPackets] = useState<DecodedPacket[]>([]);
  const [bits, setBits] = useState<{ value: boolean; startByte?: number; bitIndex?: number }[]>([]);
  const [analogSamples, setAnalogSamples] = useState<Float64Array | null>(null);
  const [stats, setStats] = useState<SignalStats | null>(null);
  const [_sampleRate, _setSampleRate] = useState(100000);
  const [statusText, setStatusText] = useState("Ready — Click Live to preview signal");

  const rafIdRef = useRef<number | null>(null);
  const lastDrawRef = useRef(0);
  const [liveWindowMs, setLiveWindowMs] = useState(500); // 1ms to 1000ms

  const dsoSettings = useMemo(() => ({
    command: DsoCommand.FreeRunning,
    triggerLevel: 0,
    mode: MeterMode.DcVoltage,
    range: 5,
    samplingWindowUs: liveWindowMs * 1000,
    numberOfSamples: Math.max(1, Math.min(4096, Math.round(liveWindowMs * 100))),
  }), [liveWindowMs]);

  const { running, ringBufRef, ringHeadRef, ringTotalRef, sampleRate: streamSampleRate } = useDsoStream({ enabled: isLive, settings: dsoSettings });

  // Use refs for live config so render loop doesn't need deps
  const configRef = useRef({ threshold, autoThreshold, snrGate, snrThreshold, relActive, relValue });
  useEffect(() => {
    configRef.current = { threshold, autoThreshold, snrGate, snrThreshold, relActive, relValue };
  }, [threshold, autoThreshold, snrGate, snrThreshold, relActive, relValue]);

  // Sync sample rate from stream
  useEffect(() => {
    if (streamSampleRate > 0) _setSampleRate(streamSampleRate);
  }, [streamSampleRate]);

  // Live render loop: reads from hook's ring buffer, decodes, renders
  useEffect(() => {
    if (!running) {
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
      return;
    }

    const renderLoop = () => {
      if (!running) return;
      const now = performance.now();
      if (now - lastDrawRef.current < 33) {
        rafIdRef.current = requestAnimationFrame(renderLoop);
        return;
      }
      lastDrawRef.current = now;

      const buf = ringBufRef.current;
      const total = ringTotalRef.current;
      if (!buf || total === 0) {
        setStatusText("Live · Waiting for signal...");
        rafIdRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      // Read last window of samples from ring buffer
      const cap = buf.length;
      const winSamples = Math.max(1, Math.min(total, Math.round(liveWindowMs * (streamSampleRate / 1000))));
      const N = Math.min(winSamples, total);
      const raw = new Float64Array(N);
      const head = ringHeadRef.current;
      for (let i = 0; i < N; i++) {
        raw[i] = buf[(head - N + i + cap) % cap];
      }

      const cfg = configRef.current;
      const signalStats = computeStats(raw);
      setStats(signalStats);

      let effectiveThreshold = cfg.threshold;
      if (cfg.autoThreshold && signalStats.span > 0.2) {
        effectiveThreshold = signalStats.suggestedThreshold;
      }

      let displayRaw = raw;
      if (cfg.relActive && cfg.relValue !== null) {
        displayRaw = new Float64Array(N);
        for (let i = 0; i < N; i++) displayRaw[i] = raw[i] - cfg.relValue;
        effectiveThreshold -= cfg.relValue;
      }

      const thresholded = thresholdSamples(displayRaw, effectiveThreshold);
      const annotated = thresholded.map((v) => ({ value: v }));

      setAnalogSamples(displayRaw);
      setBits(annotated);

      if (cfg.snrGate && signalStats.snrDb !== null && signalStats.snrDb < cfg.snrThreshold) {
        setStatusText(`Noisy · SNR ${signalStats.snrDb.toFixed(1)}dB < ${cfg.snrThreshold}dB · Signal shown, decode blocked`);
      } else {
        setStatusText(`Live · ${signalStats.span > 0.1 ? `Signal ${signalStats.span.toFixed(2)}V` : "No signal"} · SNR ${signalStats.snrDb?.toFixed(1) ?? "—"}dB`);
      }

      rafIdRef.current = requestAnimationFrame(renderLoop);
    };

    rafIdRef.current = requestAnimationFrame(renderLoop);
    return () => {
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    };
  }, [running, ringBufRef, ringHeadRef, ringTotalRef, liveWindowMs, streamSampleRate]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;
    const bitHeight = h * 0.35;
    const lowY = midY + bitHeight;
    const highY = midY - bitHeight;

    ctx.clearRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 50) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 50) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Threshold line
    ctx.strokeStyle = "rgba(255, 153, 0, 0.5)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();
    ctx.setLineDash([]);

    if (bits.length < 2) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("No data", w / 2, h / 2);
      return;
    }

    // Check if signal is flat — show message but still draw line
    let hasTransitions = false;
    for (let i = 1; i < bits.length; i++) {
      if (bits[i].value !== bits[0].value) { hasTransitions = true; break; }
    }
    if (!hasTransitions) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("No data found", w / 2, h / 2);
      const y = bits[0].value ? highY : lowY;
      ctx.strokeStyle = "#33FF33";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      return;
    }

    // Draw analog trace faintly if available (proportional across full width)
    if (analogSamples && analogSamples.length === bits.length) {
      ctx.strokeStyle = "rgba(100, 100, 100, 0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const rangeV = 6;
      for (let x = 0; x < w; x++) {
        const idx = Math.floor((x / w) * analogSamples.length);
        const avgV = analogSamples[Math.min(idx, analogSamples.length - 1)];
        const y = midY - (avgV / rangeV) * (h * 0.4);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Draw thresholded digital waveform — proportional mapping always fills canvas
    ctx.strokeStyle = "#33FF33";
    ctx.lineWidth = 2;
    ctx.beginPath();

    // Find transitions in sample space, map to pixel space
    const transitions: number[] = [0];
    for (let i = 1; i < bits.length; i++) {
      if (bits[i].value !== bits[i - 1].value) transitions.push(i);
    }
    transitions.push(bits.length);

    let currentY = bits[0].value ? highY : lowY;
    ctx.moveTo(0, currentY);
    for (let t = 1; t < transitions.length; t++) {
      const startSample = transitions[t - 1];
      const endSample = transitions[t];
      const startX = (startSample / bits.length) * w;
      const endX = (endSample / bits.length) * w;
      const y = bits[startSample].value ? highY : lowY;
      ctx.lineTo(startX, currentY);
      ctx.lineTo(startX, y);
      ctx.lineTo(endX, y);
      currentY = y;
    }
    ctx.stroke();

    // Annotate decoded bytes
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    const seenBytes = new Set<number>();
    const pxPerSample = w / bits.length;
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      if (b.startByte !== undefined && !seenBytes.has(b.startByte)) {
        seenBytes.add(b.startByte);
        const x = (i / bits.length) * w;
        ctx.fillStyle = "rgba(255, 153, 0, 0.15)";
        ctx.fillRect(x, 0, Math.max(20, pxPerSample * 10), h);
        ctx.fillStyle = "#f97316";
        ctx.fillText(`0x${packets[b.startByte]?.data.toString(16).padStart(2, "0") ?? "??"}`, x + 20, highY - 8);
      }
    }
  }, [bits, packets, analogSamples]);

  useEffect(() => { drawWaveform(); }, [bits, drawWaveform]);

  const capture = useCallback(async () => {
    const transport = getSharedTransport();
    if (!transport || !transport.isConnected) {
      setStatusText("Not connected — connect Pokit first");
      return;
    }

    // If live is running, grab from ring buffer and decode
    if (isLive) {
      setIsCapturing(true);
      const buf = ringBufRef.current;
      const total = ringTotalRef.current;
      if (!buf || total === 0) {
        setStatusText("No data in buffer yet");
        setIsCapturing(false);
        return;
      }

      const cap = buf.length;
      const N = total;
      const raw = new Float64Array(N);
      const head = ringHeadRef.current;
      for (let i = 0; i < N; i++) {
        raw[i] = buf[(head - N + i + cap) % cap];
      }

      const signalStats = computeStats(raw);
      setStats(signalStats);
      setAnalogSamples(raw);

      let effectiveThreshold = threshold;
      if (autoThreshold && signalStats.span > 0.2) {
        effectiveThreshold = signalStats.suggestedThreshold;
        setThreshold(Math.round(effectiveThreshold * 10) / 10);
      }

      let displayRaw = raw;
      if (relActive && relValue !== null) {
        displayRaw = new Float64Array(N);
        for (let i = 0; i < N; i++) displayRaw[i] = raw[i] - relValue;
        effectiveThreshold -= relValue;
      }

      const actualRate = _sampleRate || 100000;
      const thresholded = thresholdSamples(displayRaw, effectiveThreshold);
      const { packets: decoded, annotatedBits } = decodeUart(thresholded, actualRate, baudRate);

      setBits(annotatedBits);
      setPackets(decoded);
      setStatusText(`Snapshot ${N} samples · ${decoded.length} bytes decoded · Signal ${signalStats.span.toFixed(2)}V`);
      setIsCapturing(false);
      return;
    }

    // One-shot capture: collect until we have enough samples or timeout
    setIsCapturing(true);
    setStatusText("Capturing DSO...");
    setBits([]);
    setPackets([]);

    try {
      const dso = new DsoService(transport);
      const range = 5;
      const numSamples = 4096;
      const windowMs = 20;
      const windowUs = windowMs * 1000;

      const allSamples: number[] = [];
      let actualRate = 0;

      const metaUnsub = await dso.onMetadata((meta) => {
        actualRate = meta.samplingRate;
        _setSampleRate(actualRate);
      });

      const sampleUnsub = await dso.onSamples((samples) => {
        allSamples.push(...samples);
      });

      await dso.startDso({
        command: DsoCommand.FreeRunning,
        triggerLevel: 0,
        mode: MeterMode.DcVoltage,
        range,
        samplingWindowUs: windowUs,
        numberOfSamples: numSamples,
      });

      // Poll until we have all samples or 3s timeout
      const startTime = Date.now();
      while (allSamples.length < numSamples && Date.now() - startTime < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await metaUnsub();
      await sampleUnsub();

      if (allSamples.length === 0) {
        setStatusText("No samples received — check DSO tab works, then retry");
        setIsCapturing(false);
        return;
      }

      const raw = new Float64Array(allSamples.length);
      for (let i = 0; i < allSamples.length; i++) raw[i] = (allSamples[i] / 32768) * range;

      const signalStats = computeStats(raw);
      setStats(signalStats);
      setAnalogSamples(raw);

      let effectiveThreshold = threshold;
      if (autoThreshold && signalStats.span > 0.2) {
        effectiveThreshold = signalStats.suggestedThreshold;
        setThreshold(Math.round(effectiveThreshold * 10) / 10);
      }

      if (relActive && relValue !== null) {
        for (let i = 0; i < raw.length; i++) raw[i] -= relValue;
        effectiveThreshold -= relValue;
      }

      actualRate = actualRate || 100000;

      if (snrGate && signalStats.snrDb !== null && signalStats.snrDb < snrThreshold) {
        setStatusText(`Noisy signal — SNR ${signalStats.snrDb.toFixed(1)}dB < ${snrThreshold}dB`);
        setIsCapturing(false);
        return;
      }

      const thresholded = thresholdSamples(raw, effectiveThreshold);
      const { packets: decoded, annotatedBits } = decodeUart(thresholded, actualRate, baudRate);

      setBits(annotatedBits);
      setPackets(decoded);
      setStatusText(`Captured ${raw.length} samples @ ${(actualRate / 1000).toFixed(0)}kHz · ${decoded.length} bytes decoded · Signal ${signalStats.span.toFixed(2)}V`);

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusText(`Error: ${msg}`);
    } finally {
      setIsCapturing(false);
    }
  }, [isLive, threshold, baudRate, autoThreshold, snrGate, snrThreshold, relActive, relValue, _sampleRate]);

  const handleClear = () => {
    setBits([]);
    setPackets([]);
    setAnalogSamples(null);
    setStats(null);
    setStatusText("Ready");
  };

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Controls */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className={`text-xs font-mono uppercase tracking-wider ${isLive ? "text-fob-orange animate-pulse" : isCapturing ? "text-fob-orange" : packets.length > 0 ? "text-fob-green" : "text-fob-text-dim"}`}>
            {isLive ? "● LIVE" : isCapturing ? "● CAPTURING" : packets.length > 0 ? `● ${packets.length} BYTES` : "○ IDLE"}
          </span>
          <span className="text-xs font-mono text-fob-text-dim">{statusText}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsLive((v) => !v)}
            disabled={isCapturing}
            className={`px-3 py-1 rounded text-xs font-mono border ${
              isLive
                ? "bg-fob-orange/20 text-fob-orange border-fob-orange/30 hover:bg-fob-orange/30"
                : isCapturing
                  ? "bg-fob-border text-fob-text-dim cursor-wait"
                  : "bg-fob-bg text-fob-text border-fob-border hover:text-fob-orange"
            }`}
          >
            {isLive ? "Stop Live" : "Live"}
          </button>
          <button
            onClick={capture}
            disabled={isCapturing || isLive}
            className={`px-3 py-1 rounded text-xs font-mono border ${
              isCapturing || isLive
                ? "bg-fob-border text-fob-text-dim cursor-wait"
                : "bg-fob-green/20 text-fob-green border-fob-green/30 hover:bg-fob-green/30"
            }`}
          >
            {isCapturing ? "Capturing..." : "Capture"}
          </button>
          <button
            onClick={handleClear}
            className="px-3 py-1 rounded text-xs font-mono bg-fob-bg text-fob-text border border-fob-border hover:text-fob-orange"
          >
            Clear
          </button>
          <button
            onClick={() => {
              if (relActive) { setRelValue(null); setRelActive(false); }
              else if (analogSamples && analogSamples.length > 0) {
                const mean = analogSamples.reduce((a, b) => a + b, 0) / analogSamples.length;
                setRelValue(mean);
                setRelActive(true);
              }
            }}
            disabled={!analogSamples || analogSamples.length === 0}
            className={`px-2 py-1 rounded text-[10px] font-bold ${relActive ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"} disabled:opacity-40`}
          >
            {relActive ? "REL ON" : "REL"}
          </button>
          <button
            onClick={() => setSnrGate((g) => !g)}
            className={`px-2 py-1 rounded text-[10px] font-bold ${snrGate ? "bg-fob-orange text-fob-accent-text" : "bg-fob-surface border border-fob-border text-fob-text"}`}
          >
            {snrGate ? "GATE ON" : "GATE"}
          </button>
          <button
            onClick={() => {
              if (analogSamples && analogSamples.length > 0) {
                const s = computeStats(analogSamples);
                setThreshold(Math.round(s.suggestedThreshold * 10) / 10);
                setStatusText(`Calibrated · Threshold ${s.suggestedThreshold.toFixed(2)}V · Noise ${s.span.toFixed(2)}V`);
              }
            }}
            disabled={!analogSamples || analogSamples.length === 0}
            className="px-2 py-1 rounded text-[10px] font-bold bg-fob-surface border border-fob-border text-fob-text disabled:opacity-40"
          >
            CAL
          </button>
        </div>
      </div>

      {/* Signal stats bar */}
      {stats && (
        <div className="flex items-center gap-4 shrink-0 rounded border border-fob-border bg-fob-surface px-3 py-1.5">
          <span className="text-[10px] font-mono text-fob-text-dim">Signal: <span className="text-fob-text">{stats.span.toFixed(2)}V</span></span>
          <span className="text-[10px] font-mono text-fob-text-dim">Min: <span className="text-fob-text">{stats.min.toFixed(2)}V</span></span>
          <span className="text-[10px] font-mono text-fob-text-dim">Max: <span className="text-fob-text">{stats.max.toFixed(2)}V</span></span>
          <span className="text-[10px] font-mono text-fob-text-dim">Mean: <span className="text-fob-text">{stats.mean.toFixed(2)}V</span></span>
          <span className="text-[10px] font-mono text-fob-text-dim">SNR: <span className={stats.snrDb !== null && stats.snrDb < snrThreshold ? "text-fob-red" : "text-fob-green"}>{stats.snrDb?.toFixed(1) ?? "—"}dB</span></span>
          {stats.suggestedThreshold !== threshold && (
            <button
              onClick={() => setThreshold(Math.round(stats.suggestedThreshold * 10) / 10)}
              className="ml-auto text-[10px] font-mono text-fob-orange hover:underline"
            >
              Suggest {stats.suggestedThreshold.toFixed(1)}V
            </button>
          )}
        </div>
      )}

      {/* Settings */}
      <div className="grid grid-cols-5 gap-2 shrink-0">
        <div className="rounded border border-fob-border bg-fob-surface p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono text-fob-text-dim">Threshold</span>
            <label className="flex items-center gap-1 text-[10px] font-mono text-fob-orange cursor-pointer">
              <input
                type="checkbox"
                checked={autoThreshold}
                onChange={(e) => setAutoThreshold(e.target.checked)}
                className="accent-fob-orange w-3 h-3"
              />
              Auto
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range" min="0.1" max="3.3" step="0.1"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              disabled={autoThreshold}
              className="flex-1 accent-fob-orange"
            />
            <span className="text-xs font-mono text-fob-text w-10 text-right">{threshold}V</span>
          </div>
        </div>

        <div className="rounded border border-fob-border bg-fob-surface p-2">
          <div className="text-[10px] font-mono text-fob-text-dim mb-1">Baud Rate</div>
          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            className="w-full bg-fob-bg text-fob-text text-xs font-mono rounded border border-fob-border px-2 py-1"
          >
            <option value={1200}>1200</option>
            <option value={2400}>2400</option>
            <option value={4800}>4800</option>
            <option value={9600}>9600</option>
            <option value={19200}>19200</option>
            <option value={38400}>38400</option>
            <option value={57600}>57600</option>
            <option value={115200}>115200</option>
          </select>
        </div>

        <div className="rounded border border-fob-border bg-fob-surface p-2">
          <div className="text-[10px] font-mono text-fob-text-dim mb-1">Protocol</div>
          <select className="w-full bg-fob-bg text-fob-text text-xs font-mono rounded border border-fob-border px-2 py-1">
            <option value="uart">UART</option>
            <option value="i2c" disabled>I2C (soon)</option>
            <option value="spi" disabled>SPI (soon)</option>
          </select>
        </div>

        <div className="rounded border border-fob-border bg-fob-surface p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono text-fob-text-dim">SNR Gate</span>
            <label className="flex items-center gap-1 text-[10px] font-mono text-fob-orange cursor-pointer">
              <input
                type="checkbox"
                checked={snrGate}
                onChange={(e) => setSnrGate(e.target.checked)}
                className="accent-fob-orange w-3 h-3"
              />
              On
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range" min="-40" max="0" step="5"
              value={snrThreshold}
              onChange={(e) => setSnrThreshold(Number(e.target.value))}
              disabled={!snrGate}
              className="flex-1 accent-fob-orange"
            />
            <span className="text-xs font-mono text-fob-text w-10 text-right">{snrThreshold}dB</span>
          </div>
        </div>

        <div className="rounded border border-fob-border bg-fob-surface p-2">
          <div className="text-[10px] font-mono text-fob-text-dim mb-1">Live Window</div>
          <div className="flex items-center gap-2">
            <input
              type="range" min="1" max="1000" step="1"
              value={liveWindowMs}
              onChange={(e) => setLiveWindowMs(Number(e.target.value))}
              disabled={isLive}
              className="flex-1 accent-fob-orange"
              title="Live buffer window (ms) — stop live to change"
            />
            <span className="text-xs font-mono text-fob-text w-12 text-right">{liveWindowMs}ms</span>
          </div>
        </div>
      </div>

      {/* REL / Tare controls */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => {
            if (!relActive && stats) {
              setRelValue(stats.mean);
              setRelActive(true);
            } else {
              setRelActive(false);
              setRelValue(null);
            }
          }}
          className={`px-2 py-1 rounded text-[10px] font-mono border ${
            relActive
              ? "bg-fob-orange/20 text-fob-orange border-fob-orange/30"
              : "bg-fob-bg text-fob-text border-fob-border hover:text-fob-orange"
          }`}
        >
          {relActive ? `REL ${relValue?.toFixed(2)}V` : "Set REL"}
        </button>
        {relActive && (
          <button
            onClick={() => { setRelActive(false); setRelValue(null); }}
            className="px-2 py-1 rounded text-[10px] font-mono bg-fob-bg text-fob-red border border-fob-border hover:bg-fob-red/10"
          >
            Clear REL
          </button>
        )}
      </div>

      {/* Waveform Canvas */}
      <div className="flex-1 min-h-0 rounded border border-fob-border bg-fob-surface relative overflow-hidden">
        <canvas ref={canvasRef} width={800} height={300} className="w-full h-full" />
        {bits.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-fob-text-dim text-sm">
            {isLive ? "Waiting for signal..." : "Click Live to preview or Capture to decode"}
          </div>
        )}
      </div>

      {/* Decoded Packets */}
      <div className="shrink-0 rounded border border-fob-border bg-fob-surface overflow-hidden">
        <div className="px-3 py-2 border-b border-fob-border text-xs font-mono font-bold text-fob-text-dim uppercase tracking-wider">
          Decoded Packets
        </div>
        <div className="max-h-32 overflow-y-auto">
          {packets.length === 0 ? (
            <div className="px-3 py-4 text-xs font-mono text-fob-text-dim text-center">No packets decoded yet</div>
          ) : (
            packets.map((pkt, i) => (
              <div key={i} className="px-3 py-2 border-b border-fob-border flex items-center gap-4 text-xs font-mono">
                <span className="text-fob-orange w-16">#{i + 1}</span>
                <span className="text-fob-green font-bold">0x{pkt.data.toString(16).padStart(2, "0")}</span>
                <span className="text-fob-text">'{String.fromCharCode(pkt.data)}'</span>
                <span className="text-fob-text-dim">{pkt.type.toUpperCase()}</span>
                <span className="ml-auto text-fob-green">✓</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
