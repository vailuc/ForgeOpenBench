import type { ScopePreset } from "./scopeTypes";

const PRESETS_KEY = "waveforge:scopePresets";

export function loadPresets(): ScopePreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScopePreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: ScopePreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* ignore quota/security errors */
  }
}

export function createPreset(
  name: string,
  state: ScopePreset["state"]
): ScopePreset {
  return { name: name.trim(), createdAt: Date.now(), state };
}

export function exportPresets(presets: ScopePreset[]): string {
  return JSON.stringify(presets, null, 2);
}

export function importPresets(json: string): ScopePreset[] | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((p): p is ScopePreset =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as ScopePreset).name === "string" &&
      typeof (p as ScopePreset).createdAt === "number" &&
      typeof (p as ScopePreset).state === "object" &&
      (p as ScopePreset).state !== null
    );
  } catch {
    return null;
  }
}

export function uniquePresetName(presets: ScopePreset[], base: string): string {
  const names = new Set(presets.map((p) => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
