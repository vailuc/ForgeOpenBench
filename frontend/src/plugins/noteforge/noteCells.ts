import type { AnnotationLayer } from "../lensforge/types";

// ── Cell types ────────────────────────────────────────────────────────────────

export interface TextCell {
  type: "text";
  id: string;
  markdown: string;
}

export interface LensCaptureCell {
  type: "lens-capture";
  id: string;
  imageDataUrl: string;
  alt: string;
  meta: string;        // the markdown text block above the image (pane/label/filter lines)
  layers: AnnotationLayer[];
}

export interface CodeCell {
  type: "code";
  id: string;
  lang: string;
  code: string;
}

export type NoteCell = TextCell | LensCaptureCell | CodeCell;

// ── Parser ────────────────────────────────────────────────────────────────────
// Splits a markdown string into typed cells.
// A LensCaptureCell is detected when:
//   - A paragraph contains ![...](data:image/...) — base64 image
//   - Optionally followed by a <details> block containing a ```json fenced code block
//     whose content is a AnnotationLayer[]

const BASE64_IMG_RE = /!\[([^\]]*)\]\((data:image\/[^)]+)\)/;
const FENCED_CODE_RE = /```(\w*)\n([\s\S]*?)```/g;

export function parseNoteCells(markdown: string): NoteCell[] {
  const cells: NoteCell[] = [];
  let idCounter = 0;
  const nextId = () => `cell-${idCounter++}`;

  // Split on lens-capture image lines — these are the natural cell boundaries
  // Strategy: scan line by line, accumulate text until we hit a base64 image
  const lines = markdown.split("\n");
  let textAccum: string[] = [];
  let i = 0;

  const flushText = () => {
    const md = textAccum.join("\n").trim();
    if (md) cells.push({ type: "text", id: nextId(), markdown: md });
    textAccum = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Detect base64 image line
    const imgMatch = BASE64_IMG_RE.exec(line);
    if (imgMatch) {
      // Everything accumulated before this is the "meta" block for this capture
      const meta = textAccum.join("\n").trim();
      // Pop the meta from the text accumulator — it belongs to this cell
      textAccum = [];

      const alt = imgMatch[1];
      const imageDataUrl = imgMatch[2];
      let layers: AnnotationLayer[] = [];

      // Look ahead for a <details> block containing annotation JSON
      // Skip blank lines between the image and the details block
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      let detailsLines: string[] = [];
      if (j < lines.length && lines[j].trim().startsWith("<details")) {
        // Collect until </details>
        while (j < lines.length && !lines[j].includes("</details>")) {
          detailsLines.push(lines[j]);
          j++;
        }
        if (j < lines.length) detailsLines.push(lines[j]); // include </details>

        // Extract JSON from fenced code block inside details
        const detailsBlock = detailsLines.join("\n");
        FENCED_CODE_RE.lastIndex = 0;
        const codeMatch = FENCED_CODE_RE.exec(detailsBlock);
        if (codeMatch) {
          try {
            const parsed = JSON.parse(codeMatch[2].trim());
            if (Array.isArray(parsed)) layers = parsed as AnnotationLayer[];
          } catch { /* malformed JSON — skip layers */ }
        }
        i = j + 1; // skip past the details block
      } else {
        i = i + 1;
      }

      cells.push({ type: "lens-capture", id: nextId(), imageDataUrl, alt, meta, layers });
      continue;
    }

    // Detect standalone fenced code blocks (not inside details)
    if (line.startsWith("```")) {
      flushText();
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      cells.push({ type: "code", id: nextId(), lang, code: codeLines.join("\n") });
      continue;
    }

    textAccum.push(line);
    i++;
  }

  flushText();
  return cells;
}

// ── Patch helpers ─────────────────────────────────────────────────────────────

/**
 * Rewrite the annotation layers JSON for a specific capture (identified by its
 * imageDataUrl prefix) inside raw note markdown. If newLayers is empty/all-empty,
 * the entire <details> block is removed.
 */
export function patchLayersInMarkdown(
  markdown: string,
  imageDataUrl: string,
  newLayers: AnnotationLayer[]
): string {
  const lines = markdown.split("\n");
  // Find the image line
  const imgIdx = lines.findIndex((l) => l.includes(imageDataUrl.slice(0, 60)));
  if (imgIdx === -1) return markdown;

  // Find the <details> block start (skip blank lines after image)
  let detStart = imgIdx + 1;
  while (detStart < lines.length && lines[detStart].trim() === "") detStart++;
  if (detStart >= lines.length || !lines[detStart].trim().startsWith("<details")) {
    // No existing block — insert one after the image line
    const totalItems = newLayers.reduce((s, l) => s + l.items.length, 0);
    if (totalItems === 0) return markdown;
    const block = `\n\n<details><summary>Annotations (${totalItems} items, ${newLayers.length} layers)</summary>\n\n\`\`\`json\n${JSON.stringify(newLayers, null, 2)}\n\`\`\`\n\n</details>`;
    const out = [...lines];
    out.splice(imgIdx + 1, 0, ...block.split("\n"));
    return out.join("\n");
  }

  // Find the </details> end
  let detEnd = detStart;
  while (detEnd < lines.length && !lines[detEnd].includes("</details>")) detEnd++;

  const totalItems = newLayers.reduce((s, l) => s + l.items.length, 0);
  const out = [...lines];
  if (totalItems === 0) {
    // Remove the entire details block plus surrounding blank lines
    let removeStart = detStart;
    while (removeStart > imgIdx + 1 && out[removeStart - 1].trim() === "") removeStart--;
    out.splice(removeStart, detEnd - removeStart + 1);
  } else {
    const newBlock = [
      `<details><summary>Annotations (${totalItems} items, ${newLayers.length} layers)</summary>`,
      "",
      "```json",
      JSON.stringify(newLayers, null, 2),
      "```",
      "",
      "</details>",
    ];
    out.splice(detStart, detEnd - detStart + 1, ...newBlock);
  }
  return out.join("\n");
}
