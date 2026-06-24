/**
 * Web Audio beep for continuity mode.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export function beep(durationMs = 150, freq = 1200, volume = 0.3): void {
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.connect(gain);
    gain.connect(c.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + durationMs / 1000);
    osc.start();
    osc.stop(c.currentTime + durationMs / 1000);
  } catch {
    // Audio context may be blocked until user interaction.
  }
}
