import type { SerialLine } from "./MonitorForgeApp";

export function downloadFile(data: string, filename: string, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportTerminalText(lines: SerialLine[]): string {
  return lines
    .map((l) => `[${l.ts}] ${l.dir === "rx" ? "←" : l.dir === "tx" ? "→" : "·"} ${l.text}`)
    .join("\n");
}

export function exportPlotterCsv(lines: string[]): string | null {
  const rows: number[][] = [];
  for (const line of lines) {
    const nums = line.split(",").map((s) => parseFloat(s.trim()));
    if (nums.length === 0 || nums.some((n) => isNaN(n))) continue;
    rows.push(nums);
  }
  if (rows.length === 0) return null;

  const maxSeries = Math.max(...rows.map((r) => r.length));
  const headers = ["index"];
  for (let i = 0; i < maxSeries; i++) headers.push(`S${i}`);

  const out = [headers.join(",")];
  rows.forEach((r, idx) => {
    const cells = [String(idx), ...r.map((n) => String(n))];
    while (cells.length < maxSeries + 1) cells.push("");
    out.push(cells.join(","));
  });
  return out.join("\n");
}

export function downloadImage(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function dataUrlToBase64(dataUrl: string): { mime: string; b64: string } | null {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) return null;
  return { mime: match[1] || "application/octet-stream", b64: match[2] };
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const parsed = dataUrlToBase64(dataUrl);
  if (!parsed) return null;
  const bin = atob(parsed.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: parsed.mime });
}

export async function saveToProject(
  project: string,
  path: string,
  data: string | { mime: string; b64: string },
  filename: string
): Promise<{ ok: boolean; path: string; fallback: boolean }> {
  const fallback = (payload: string | { mime: string; b64: string }) => {
    if (typeof payload === "string") {
      downloadFile(payload, filename, "text/plain");
    } else {
      const blob = dataUrlToBlob(`data:${payload.mime};base64,${payload.b64}`);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  if (!project) {
    fallback(data);
    return { ok: false, path: "", fallback: true };
  }

  const url = `/api/v1/workspace/projects/${encodeURIComponent(project)}/asset?path=${encodeURIComponent(path)}`;
  const body = typeof data === "string" ? { content: data } : { data: data.b64 };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    return { ok: true, path: result.path ?? path, fallback: false };
  } catch (e) {
    fallback(data);
    return { ok: false, path: "", fallback: true };
  }
}
